import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLEANUP_CASE_PATTERN_FLAGS,
  CLEANUP_CASES,
  type CleanupCase,
  type CleanupCaseSeverity,
} from "./cleanupCases";
import {
  CLEANUP_HOLDOUT_CASES,
  type CleanupEvalCase as CleanupHoldoutCase,
} from "./cleanupHoldoutCases";
import {
  CLEANUP_FINAL_HOLDOUT_CASES,
  type CleanupEvalCase as CleanupFinalHoldoutCase,
} from "./cleanupFinalHoldoutCases";
import {
  CLEANUP_PROMPT_CANDIDATES,
  type CleanupPromptCandidate,
} from "./cleanupPrompts";
import { plausibleLength } from "../src/core/cleanup";
import { normalizeConfig, SECRET_FIELDS, type UndertoneConfig } from "../src/core/config";
import type { SecretCipher } from "../src/main/configStore";
import {
  OpenAiSubscription,
  openAiCredentials,
} from "../src/main/openAiSubscription";
import { FetchHttpClient } from "../src/platform/http";
import { WindowsHost } from "../src/platform/windowsHost";

const APP_VERSION = "1.8.1";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REPEATS = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const PRODUCTION_DEADLINE_MS = 2_500;
const MAX_CONCURRENCY = 8;
const MAX_REPEATS = 10;
const MAX_TIMEOUT_MS = 60_000;
const MAX_JOBS = 2_000;

type EvalReasoningEffort = "none" | "low";
type EvalSuite = "development" | "holdout" | "final-holdout";
type EvalCase = CleanupCase | CleanupHoldoutCase | CleanupFinalHoldoutCase;

interface EvalResult {
  readonly promptId: string;
  readonly caseId: string;
  readonly category: EvalCase["category"];
  readonly severity: CleanupCaseSeverity;
  readonly repeat: number;
  readonly transcript: string;
  readonly output: string | null;
  readonly latencyMs: number;
  readonly failures: readonly string[];
  readonly error: string | null;
}

interface EvalSummary {
  readonly promptId: string;
  readonly passed: number;
  readonly total: number;
  readonly criticalFailures: number;
  readonly majorFailures: number;
  readonly minorFailures: number;
  readonly transportFailures: number;
  readonly responsesOverProductionDeadline: number;
  readonly medianLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly byCategory: Readonly<Record<string, { passed: number; total: number }>>;
}

describe("GPT-5.6 Luna cleanup prompt evaluation", () => {
  it("runs fresh cleanup cases through Undertone OAuth", async () => {
    const options = evalOptions();
    const configPath = productionConfigPath();
    console.log("REPORT ONLY: quality misses are recorded in JSON; transport errors fail the run.");
    const host = new WindowsHost();
    let hostRunning = false;
    let subscription: OpenAiSubscription | null = null;

    try {
      await host.start();
      hostRunning = true;
      await host.setInputMode("off");
      const config = await loadConfigReadOnly(configPath, host);
      const credentials = openAiCredentials(config);
      if (credentials === null) {
        throw new Error("Undertone has no connected OpenAI OAuth account.");
      }

      subscription = new OpenAiSubscription({
        http: new FetchHttpClient(),
        credentials,
        persist: async () => {},
        openExternal: async () => {
          throw new Error("The cleanup evaluator cannot start an OAuth sign-in.");
        },
        appVersion: APP_VERSION,
        requestCredentialMode: "read-only",
      });

      await host.stop();
      hostRunning = false;

      const jobs = options.cases.flatMap((caseValue) =>
        Array.from({ length: options.repeats }, (_, index) =>
          options.prompts.map((prompt) => ({
            prompt,
            caseValue,
            repeat: index + 1,
          }))).flat());
      if (jobs.length > MAX_JOBS) {
        throw new Error(`Cleanup evaluation selected ${jobs.length} jobs; maximum is ${MAX_JOBS}.`);
      }
      const results = await runWorkers(jobs, options.concurrency, async (job) =>
        await runCase(
          subscription!,
          job.prompt,
          job.caseValue,
          job.repeat,
          options.timeoutMs,
          options.reasoningEffort,
        ));
      const summaries = options.prompts.map((prompt) => summarize(prompt.id, results));
      const outputPath = await writeResults(options, results, summaries);

      printSummaries(summaries, outputPath);
      printFailures(results);

      expect(results).toHaveLength(jobs.length);
      expect(results.filter(({ error }) => error !== null)).toEqual([]);
    } finally {
      subscription?.dispose();
      if (hostRunning) await host.stop();
    }
  });
});

function evalOptions(): {
  concurrency: number;
  repeats: number;
  timeoutMs: number;
  reasoningEffort: EvalReasoningEffort;
  suite: EvalSuite;
  prompts: readonly CleanupPromptCandidate[];
  cases: readonly EvalCase[];
} {
  const concurrency = positiveInteger(
    process.env.UNDERTONE_CLEANUP_EVAL_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const repeats = positiveInteger(
    process.env.UNDERTONE_CLEANUP_EVAL_REPEATS,
    DEFAULT_REPEATS,
    MAX_REPEATS,
  );
  const timeoutMs = positiveInteger(
    process.env.UNDERTONE_CLEANUP_EVAL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const reasoningEffort = process.env.UNDERTONE_CLEANUP_EVAL_REASONING_EFFORT === "low"
    ? "low"
    : "none";
  const suiteValue = process.env.UNDERTONE_CLEANUP_EVAL_SUITE;
  if (suiteValue !== undefined
    && suiteValue !== "development"
    && suiteValue !== "holdout"
    && suiteValue !== "final-holdout") {
    throw new Error(`Unknown cleanup evaluation suite: ${JSON.stringify(suiteValue)}.`);
  }
  const suite: EvalSuite = suiteValue === "holdout" || suiteValue === "final-holdout"
    ? suiteValue
    : "development";
  const promptFilter = commaSeparated(process.env.UNDERTONE_CLEANUP_EVAL_PROMPTS);
  const caseFilter = commaSeparated(process.env.UNDERTONE_CLEANUP_EVAL_CASES);
  const prompts = promptFilter.length === 0
    ? CLEANUP_PROMPT_CANDIDATES
    : CLEANUP_PROMPT_CANDIDATES.filter(({ id }) => promptFilter.includes(id));
  const suiteCases: readonly EvalCase[] = suite === "holdout"
    ? CLEANUP_HOLDOUT_CASES
    : suite === "final-holdout"
      ? CLEANUP_FINAL_HOLDOUT_CASES
      : CLEANUP_CASES;
  const cases = caseFilter.length === 0
    ? suiteCases
    : suiteCases.filter(({ id }) => caseFilter.includes(id));
  assertAllSelected("prompt", promptFilter, prompts.map(({ id }) => id));
  assertAllSelected("case", caseFilter, cases.map(({ id }) => id));
  if (prompts.length === 0) throw new Error("The prompt filter selected no candidates.");
  if (cases.length === 0) throw new Error("The case filter selected no cases.");
  return {
    concurrency,
    repeats,
    timeoutMs,
    reasoningEffort,
    suite,
    prompts,
    cases,
  };
}

async function runCase(
  subscription: OpenAiSubscription,
  prompt: CleanupPromptCandidate,
  caseValue: EvalCase,
  repeat: number,
  timeoutMs: number,
  reasoningEffort: EvalReasoningEffort,
): Promise<EvalResult> {
  const started = performance.now();
  try {
    const response = await subscription.complete({
      reasoningEffort,
      serviceTier: "priority",
      userPrompt: JSON.stringify({ transcript: caseValue.transcript }),
      timeoutMs,
      systemPrompt: prompt.prompt,
    });
    const output = parseCleanupText(response);
    return {
      promptId: prompt.id,
      caseId: caseValue.id,
      category: caseValue.category,
      severity: caseValue.severity,
      repeat,
      transcript: caseValue.transcript,
      output,
      latencyMs: Math.round(performance.now() - started),
      failures: checkOutput(output, caseValue),
      error: null,
    };
  } catch (error) {
    return {
      promptId: prompt.id,
      caseId: caseValue.id,
      category: caseValue.category,
      severity: caseValue.severity,
      repeat,
      transcript: caseValue.transcript,
      output: null,
      latencyMs: Math.round(performance.now() - started),
      failures: [],
      error: error instanceof Error ? error.message : "Unknown cleanup evaluation failure.",
    };
  }
}

function parseCleanupText(response: string): string {
  const value: unknown = JSON.parse(response);
  if (typeof value !== "object" || value === null || !("text" in value)
    || typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("Luna returned an invalid cleanup object.");
  }
  return value.text.trim();
}

function checkOutput(output: string, caseValue: EvalCase): string[] {
  const failures: string[] = [];
  for (const pattern of caseValue.mustMatch) {
    if (!new RegExp(pattern, CLEANUP_CASE_PATTERN_FLAGS).test(output)) {
      failures.push(`missing /${pattern}/${CLEANUP_CASE_PATTERN_FLAGS}`);
    }
  }
  for (const pattern of caseValue.mustNotMatch) {
    if (new RegExp(pattern, CLEANUP_CASE_PATTERN_FLAGS).test(output)) {
      failures.push(`contains /${pattern}/${CLEANUP_CASE_PATTERN_FLAGS}`);
    }
  }
  if (!plausibleLength(output, caseValue.transcript)) {
    failures.push("fails production length gate");
  }
  return failures;
}

async function runWorkers<T, R>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(jobs.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= jobs.length) return;
      results[index] = await run(jobs[index]!);
    }
  }));
  return results;
}

function summarize(promptId: string, results: readonly EvalResult[]): EvalSummary {
  const selected = results.filter((result) => result.promptId === promptId);
  const passing = selected.filter((result) => result.error === null && result.failures.length === 0);
  const failing = selected.filter((result) => result.error !== null || result.failures.length > 0);
  const latencies = selected.filter(({ error }) => error === null).map(({ latencyMs }) => latencyMs);
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const result of selected) {
    const bucket = byCategory[result.category] ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (result.error === null && result.failures.length === 0) bucket.passed += 1;
    byCategory[result.category] = bucket;
  }
  return {
    promptId,
    passed: passing.length,
    total: selected.length,
    criticalFailures: failing.filter(({ severity }) => severity === "critical").length,
    majorFailures: failing.filter(({ severity }) => severity === "major").length,
    minorFailures: failing.filter(({ severity }) => severity === "minor").length,
    transportFailures: failing.filter(({ error }) => error !== null).length,
    responsesOverProductionDeadline: selected.filter(
      ({ latencyMs }) => latencyMs > PRODUCTION_DEADLINE_MS,
    ).length,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    byCategory,
  };
}

async function writeResults(
  options: ReturnType<typeof evalOptions>,
  results: readonly EvalResult[],
  summaries: readonly EvalSummary[],
): Promise<string> {
  const directory = path.resolve(
    __dirname,
    "..",
    "test-output",
    "cleanup-eval",
  );
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputPath = path.join(directory, `${timestamp}.json`);
  await writeFile(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    model: "gpt-5.6-luna",
    suite: options.suite,
    reasoningEffort: options.reasoningEffort,
    serviceTier: "priority",
    credentialMode: "read-only",
    concurrency: options.concurrency,
    repeats: options.repeats,
    timeoutMs: options.timeoutMs,
    productionDeadlineMs: PRODUCTION_DEADLINE_MS,
    prompts: options.prompts.map(({ id, prompt }) => ({
      id,
      sha256: createHash("sha256").update(prompt).digest("hex"),
      text: prompt,
    })),
    summaries,
    results,
  }, null, 2), "utf8");
  return outputPath;
}

function printSummaries(summaries: readonly EvalSummary[], outputPath: string): void {
  console.log("\nCleanup evaluation summary");
  for (const summary of summaries) {
    console.log(
      `${summary.promptId}: ${summary.passed}/${summary.total} passed; `
      + `critical=${summary.criticalFailures}, major=${summary.majorFailures}, `
      + `minor=${summary.minorFailures}, transport=${summary.transportFailures}; `
      + `over-2.5s=${summary.responsesOverProductionDeadline}; `
      + `p50=${summary.medianLatencyMs}ms, p95=${summary.p95LatencyMs}ms`,
    );
    console.log(Object.entries(summary.byCategory)
      .map(([category, value]) => `${category}=${value.passed}/${value.total}`)
      .join("  "));
  }
  console.log(`Results: ${outputPath}\n`);
}

function printFailures(results: readonly EvalResult[]): void {
  for (const result of results) {
    if (result.error === null && result.failures.length === 0) continue;
    console.log(
      `[${result.promptId}] ${result.caseId} ${result.severity}: `
      + (result.error ?? result.failures.join("; ")),
    );
    if (result.output !== null) console.log(`  ${result.output}`);
  }
}

function productionConfigPath(): string {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData.length === 0) {
    throw new Error("APPDATA is unavailable.");
  }
  return path.join(appData, "Undertone", "config.json");
}

async function loadConfigReadOnly(
  configPath: string,
  cipher: SecretCipher,
): Promise<UndertoneConfig> {
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = normalizeConfig(parsed);
  for (const field of SECRET_FIELDS) {
    const value = config[field];
    if (typeof value === "string") config[field] = await cipher.unprotectSecret(value);
  }
  return config;
}

function commaSeparated(value: string | undefined): readonly string[] {
  return value?.split(",").map((part) => part.trim()).filter((part) => part.length > 0) ?? [];
}

function assertAllSelected(
  kind: "prompt" | "case",
  requested: readonly string[],
  selected: readonly string[],
): void {
  const unknown = requested.filter((value) => !selected.includes(value));
  if (unknown.length > 0) {
    throw new Error(`Unknown cleanup evaluation ${kind} IDs: ${unknown.join(", ")}.`);
  }
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `Expected an integer from 1 through ${maximum}, received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * fraction)]!;
}
