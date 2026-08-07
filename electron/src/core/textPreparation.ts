import {
  DEFAULT_CONFIG,
  isRecord,
  modelOverride,
  providerKey,
  type CleanupReasoningEffort,
  type CleanupServiceTier,
  type UndertoneConfig,
} from "./config";
import {
  CHAT_APPS,
  applyCorrections,
  finalize,
  stripChatPeriod,
  tailContext,
  type Corrections,
} from "./textproc";

export interface CaretContext {
  before: string | null;
  after: string | null;
}

export interface AppIdentity {
  executable: string | null;
  title: string | null;
}

export interface CleanupRequest {
  transcript: string;
  context: string | null;
  app: string;
  corrections: Corrections;
  apiKey: string;
  model: string;
  provider: string;
  timeoutSeconds: number;
  reasoningEffort: CleanupReasoningEffort;
  serviceTier: CleanupServiceTier;
}

export interface TextPreparationDependencies {
  acquireContext(): Promise<CaretContext>;
  getAppIdentity(): Promise<AppIdentity>;
  cleanup(request: CleanupRequest): Promise<string | null>;
}

export interface TextPreparationResult {
  text: string;
  cleanupFailed: boolean;
}

export async function prepareText(
  text: string,
  config: UndertoneConfig,
  dependencies: TextPreparationDependencies,
): Promise<TextPreparationResult> {
  const smart = Boolean(config.smart_formatting);
  const corrections = stringMap(config.corrections);
  const context = smart
    ? await dependencies.acquireContext()
    : { before: null, after: null };
  const identity = await dependencies.getAppIdentity();
  const executable = identity.executable ?? "";

  let final: string | null = null;
  let cleanupFailed = false;
  if (Boolean(config.ai_cleanup)) {
    const app = identity.title === null || identity.title.length === 0
      ? executable
      : executable.length > 0 ? `${executable} (${identity.title})` : identity.title;
    const provider = stringValue(config.cleanup_provider, DEFAULT_CONFIG.cleanup_provider);
    const cleaned = await dependencies.cleanup({
      transcript: applyCorrections(text, corrections),
      context: context.before,
      app,
      corrections,
      apiKey: providerKey(config, provider),
      model: modelOverride(config, "cleanup", provider),
      provider,
      timeoutSeconds: nonzeroNumber(config.cleanup_timeout, DEFAULT_CONFIG.cleanup_timeout),
      reasoningEffort: config.cleanup_reasoning_effort,
      serviceTier: config.cleanup_service_tier,
    });
    if (cleaned !== null) {
      final = finalize(cleaned, context.before, corrections, {
        smart,
        modelCased: true,
        afterContext: context.after,
      });
    } else cleanupFailed = true;
  }
  final ??= finalize(text, context.before, corrections, {
    smart,
    afterContext: context.after,
  });
  return {
    text: smart && CHAT_APPS.has(executable) ? stripChatPeriod(final) : final,
    cleanupFailed,
  };
}

export interface ContextSource {
  getCaretContext(before: number, after: number): Promise<CaretContext | null>;
  getForegroundWindow(): Promise<string>;
}

interface PasteMemory {
  window: string;
  text: string;
  pastedAt: number;
  inputGeneration: number;
}

export class InsertionMemory {
  private inputGeneration = 0;
  private lastPaste: PasteMemory | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  invalidate(): void {
    this.inputGeneration += 1;
  }

  captureGeneration(): number {
    return this.inputGeneration;
  }

  registerPaste(window: string, text: string, inputGeneration = this.inputGeneration): void {
    this.lastPaste = {
      window,
      text,
      pastedAt: this.now(),
      inputGeneration,
    };
  }

  async acquire(source: ContextSource): Promise<CaretContext> {
    const nativeContext = await source.getCaretContext(300, 300);
    if (nativeContext !== null) return nativeContext;
    const window = await source.getForegroundWindow();
    const paste = this.lastPaste;
    const usable = paste !== null
      && paste.inputGeneration === this.inputGeneration
      && paste.window === window
      && this.now() - paste.pastedAt < 300_000;
    return { before: usable ? tailContext(paste.text, 300) : null, after: null };
  }
}

function stringMap(value: unknown): Record<string, string> {
  return isRecord(value) ? value as Record<string, string> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nonzeroNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0
    ? value
    : fallback;
}
