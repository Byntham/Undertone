import { isRecord } from "./config";
import type { HttpClient, HttpRequest, HttpResponse } from "../platform/http";
import {
  isTranscriptionProvider,
  type LocalSttEngineId,
  type TranscriptionProviderId,
} from "../shared/settings";
import { DEFAULT_STT_MODELS } from "../shared/models";

const STT_TIMEOUT_MS = 120_000;

export class TranscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

export interface LocalSttRuntime {
  withServer<T>(
    engine: LocalSttEngineId,
    policy: "wait",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T>;
}

export interface TranscribeOptions {
  wav: Uint8Array;
  apiKey: string;
  language: string;
  vocabulary: readonly string[];
  provider: TranscriptionProviderId;
  localEngine?: LocalSttEngineId;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalPreviewTranscribeOptions {
  wav: Uint8Array;
  language: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalPreviewToken {
  id: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface LocalPreviewResult {
  text: string;
  tokens: readonly LocalPreviewToken[];
}

export class Transcriber {
  constructor(
    private readonly http: HttpClient,
    private readonly local: LocalSttRuntime,
  ) {}

  async transcribe(options: TranscribeOptions): Promise<string> {
    const provider = options.provider;
    const apiKey = options.apiKey.trim();
    if (!isTranscriptionProvider(provider)) {
      throw new TranscriptionError(
        `Unknown transcription provider '${provider}' in the config. `
        + "Pick a provider in Settings → Speech & AI.",
      );
    }
    if (provider !== "local" && apiKey.length === 0) {
      throw new TranscriptionError(
        "No API key configured for the transcription provider. "
        + "Open Settings → Speech & AI and enter one.",
      );
    }
    const normalized = { ...options, apiKey };
    switch (provider) {
      case "xai": return await this.transcribeXai(normalized);
      case "openai": return await this.transcribeOpenAi(normalized);
      case "openrouter": return await this.transcribeOpenRouter(normalized);
      case "local": return await this.transcribeLocal(normalized);
    }
  }

  async transcribeLocalPreview(
    options: LocalPreviewTranscribeOptions,
  ): Promise<LocalPreviewResult> {
    try {
      return await this.local.withServer("whisper", "wait", async (baseUrl) => {
        const form = audioForm(options.wav);
        form.append("response_format", "verbose_json");
        form.append("language", options.language);
        form.append("prompt", options.prompt);
        form.append("temperature", "0");
        form.append("temperature_inc", "0");
        form.append("best_of", "1");
        form.append("beam_size", "1");
        form.append("token_timestamps", "true");
        form.append("no_language_probabilities", "true");
        const payload = await this.postJson(`${baseUrl}/inference`, "Local", {
          body: form,
          timeoutMs: options.timeoutMs ?? STT_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }, localConnectionMessage());
        return localPreviewFromPayload(payload);
      });
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError(errorMessage(error), { cause: error });
    }
  }

  private async transcribeXai(options: NormalizedOptions): Promise<string> {
    const form = audioForm(options.wav);
    form.append("language", options.language);
    form.append("format", "true");
    for (const rawTerm of options.vocabulary.slice(0, 100)) {
      const term = rawTerm.trim().slice(0, 50);
      if (term.length > 0) form.append("keyterm", term);
    }
    const response = await this.post(
      "https://api.x.ai/v1/stt",
      "xAI",
      {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        timeoutMs: STT_TIMEOUT_MS,
      },
    );
    const responseText = response.body;
    if (response.status === 400 && responseText.includes("Incorrect API key")) {
      throw new TranscriptionError(
        "Invalid xAI API key. Check it in Settings → Speech & AI.",
      );
    }
    checkResponse(response.status, responseText, "xAI");
    return textFromPayload(parseJson(responseText, "xAI"));
  }

  private async transcribeOpenAi(options: NormalizedOptions): Promise<string> {
    const form = audioForm(options.wav);
    form.append("model", DEFAULT_STT_MODELS.openai);
    form.append("language", options.language);
    const payload = await this.postJson(
      "https://api.openai.com/v1/audio/transcriptions",
      "OpenAI",
      {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        timeoutMs: STT_TIMEOUT_MS,
      },
    );
    return textFromPayload(payload);
  }

  private async transcribeOpenRouter(options: NormalizedOptions): Promise<string> {
    const body = JSON.stringify({
      model: DEFAULT_STT_MODELS.openrouter,
      input_audio: {
        data: Buffer.from(options.wav).toString("base64"),
        format: "wav",
      },
      language: options.language,
    });
    const payload = await this.postJson(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      "OpenRouter",
      {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        timeoutMs: STT_TIMEOUT_MS,
      },
    );
    return textFromPayload(payload);
  }

  private async transcribeLocal(options: NormalizedOptions): Promise<string> {
    try {
      const engine = options.localEngine ?? "whisper";
      return await this.local.withServer(engine, "wait", async (baseUrl) => {
        const form = audioForm(options.wav);
        form.append("response_format", "json");
        form.append("language", options.language);
        const endpoint = engine === "nemotron" ? "/v1/audio/transcriptions" : "/inference";
        const payload = await this.postJson(`${baseUrl}${endpoint}`, "Local", {
          body: form,
          timeoutMs: options.timeoutMs ?? STT_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }, localConnectionMessage());
        const text = textFromPayload(payload);
        return text.split(/\s+/u).filter(Boolean).join(" ");
      });
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError(errorMessage(error), { cause: error });
    }
  }

  private async postJson(
    url: string,
    provider: string,
    request: HttpRequest,
    connectionMessage?: string,
  ): Promise<unknown> {
    const response = await this.post(url, provider, request, connectionMessage);
    const responseText = response.body;
    checkResponse(response.status, responseText, provider);
    return parseJson(responseText, provider);
  }

  private async post(
    url: string,
    provider: string,
    request: HttpRequest,
    connectionMessage?: string,
  ): Promise<HttpResponse> {
    try {
      return await this.http.post(url, request);
    } catch (error) {
      throw new TranscriptionError(connectionMessage
        ?? `Could not reach the ${provider} API. Check your internet connection and try again.`, {
        cause: error,
      });
    }
  }
}

interface NormalizedOptions extends TranscribeOptions {
  apiKey: string;
  language: string;
  vocabulary: readonly string[];
}

function audioForm(wav: Uint8Array): FormData {
  const form = new FormData();
  const bytes = wav.slice().buffer as ArrayBuffer;
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
  return form;
}

function checkResponse(status: number, text: string, provider: string): void {
  if (status === 200) return;
  if (status === 401 || status === 403) {
    throw new TranscriptionError(
      `Invalid ${provider} API key. Check it in Settings → Speech & AI.`,
    );
  }
  if (status === 429) {
    throw new TranscriptionError(`Rate limited by ${provider} — wait a moment and try again.`);
  }
  if (status === 413) {
    throw new TranscriptionError(`Recording too large for the ${provider} API.`);
  }
  throw new TranscriptionError(
    `${provider} API error (HTTP ${status}): ${text.slice(0, 200)}`,
  );
}

function parseJson(text: string, provider: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TranscriptionError(
      `${provider} API returned an unexpected (non-JSON) response.`,
      { cause: error },
    );
  }
}

function textFromPayload(payload: unknown): string {
  return isRecord(payload) && typeof payload.text === "string"
    ? payload.text.trim()
    : "";
}

function localPreviewFromPayload(payload: unknown): LocalPreviewResult {
  const text = textFromPayload(payload).split(/\s+/u).filter(Boolean).join(" ");
  if (!isRecord(payload) || !Array.isArray(payload.segments)) {
    throw new TranscriptionError("Local preview returned an unexpected response.");
  }
  const tokens: LocalPreviewToken[] = [];
  for (const segment of payload.segments) {
    if (!isRecord(segment) || !Array.isArray(segment.tokens) || !Array.isArray(segment.words)) {
      continue;
    }
    const count = Math.min(segment.tokens.length, segment.words.length);
    for (let index = 0; index < count; index += 1) {
      const id = segment.tokens[index];
      const word = segment.words[index];
      if (typeof id !== "number"
          || !Number.isSafeInteger(id)
          || !isRecord(word)
          || typeof word.word !== "string"
          || !isFiniteNumber(word.start)
          || !isFiniteNumber(word.end)
          || word.start < 0
          || word.end < word.start) continue;
      tokens.push({
        id,
        text: word.word,
        startSeconds: word.start,
        endSeconds: word.end,
      });
    }
  }
  if (text.length > 0 && tokens.length === 0) {
    throw new TranscriptionError("Local preview did not return timestamped tokens.");
  }
  return { text, tokens };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function localConnectionMessage(): string {
  return "The local transcription engine stopped responding — try Eject then Load "
    + "in Settings → Speech & AI.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
