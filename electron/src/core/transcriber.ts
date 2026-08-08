import { isRecord } from "./config";
import type { HttpClient, HttpRequest, HttpResponse } from "../platform/http";
import { DEFAULT_STT_MODELS } from "../shared/models";
import type { TranscriptionProviderId } from "../shared/settings";

const STT_TIMEOUT_MS = 120_000;

export class TranscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

export interface LocalSttRuntime {
  ensureReady(model: string): Promise<string> | string;
}

export interface TranscribeOptions {
  wav: Uint8Array;
  apiKey: string;
  language?: string;
  vocabulary?: readonly unknown[];
  provider?: string;
  model?: string;
}

export class Transcriber {
  constructor(
    private readonly http: HttpClient,
    private readonly local: LocalSttRuntime,
  ) {}

  async transcribe(options: TranscribeOptions): Promise<string> {
    const provider = options.provider ?? "xai";
    const apiKey = options.apiKey.trim();
    if (!isProvider(provider)) {
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
    const normalized = {
      ...options,
      apiKey,
      language: options.language ?? "en",
      vocabulary: options.vocabulary ?? [],
      model: options.model ?? "",
    };
    switch (provider) {
      case "xai": return await this.transcribeXai(normalized);
      case "openai": return await this.transcribeOpenAi(normalized);
      case "openrouter": return await this.transcribeOpenRouter(normalized);
      case "local": return await this.transcribeLocal(normalized);
    }
  }

  private async transcribeXai(options: NormalizedOptions): Promise<string> {
    const form = audioForm(options.wav);
    form.append("language", options.language);
    form.append("format", "true");
    for (const rawTerm of options.vocabulary.slice(0, 100)) {
      const term = String(rawTerm).trim().slice(0, 50);
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
    form.append("model", options.model || DEFAULT_STT_MODELS.openai);
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
      model: options.model || DEFAULT_STT_MODELS.openrouter,
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
    let baseUrl: string;
    try {
      baseUrl = await this.local.ensureReady(options.model);
    } catch (error) {
      throw new TranscriptionError(errorMessage(error), { cause: error });
    }
    const form = audioForm(options.wav);
    form.append("response_format", "json");
    form.append("language", options.language);
    const payload = await this.postJson(`${baseUrl}/inference`, "Local", {
      body: form,
      timeoutMs: STT_TIMEOUT_MS,
    }, "The local transcription engine stopped responding — try Eject then Load "
      + "in Settings → Speech & AI.");
    const text = textFromPayload(payload);
    return text.split(/\s+/u).filter(Boolean).join(" ");
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
  vocabulary: readonly unknown[];
  model: string;
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

function isProvider(provider: string): provider is TranscriptionProviderId {
  return provider === "xai" || provider === "openai"
    || provider === "openrouter" || provider === "local";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
