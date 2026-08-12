import { describe, expect, it } from "vitest";

import {
  Transcriber,
  TranscriptionError,
  type LocalSttRuntime,
} from "../src/core/transcriber";
import { DEFAULT_STT_MODELS } from "../src/shared/models";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/platform/http";

const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...new Array<number>(64).fill(0)]);
const VOCABULARY = ["Undertone", "Kubernetes"];

class FakeHttp implements HttpClient {
  readonly calls: Array<{ url: string; request: HttpRequest }> = [];
  response: HttpResponse = response(200, { text: "hi" });
  error: Error | undefined;

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    this.calls.push({ url, request });
    if (this.error !== undefined) throw this.error;
    return this.response;
  }
}

const local: LocalSttRuntime = {
  async withServer(_policy, callback) {
    return await callback("http://127.0.0.1:9");
  },
};

describe("transcription providers", () => {
  it("sends xAI multipart keyterms and no model field", async () => {
    const http = new FakeHttp();
    const transcriber = new Transcriber(http, local);
    expect(await transcriber.transcribe({
      wav: WAV,
      apiKey: "k",
      language: "en",
      vocabulary: VOCABULARY,
      provider: "xai",
    })).toBe("hi");
    const call = http.calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/stt");
    expect(call.request.headers).toEqual({ Authorization: "Bearer k" });
    const form = expectForm(call.request.body);
    expect(form.getAll("keyterm")).toEqual(VOCABULARY);
    expect(form.get("format")).toBe("true");
    expect(form.get("language")).toBe("en");
    expect(form.has("model")).toBe(false);
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("sends OpenAI multipart without vocabulary prompting", async () => {
    const http = new FakeHttp();
    const transcriber = new Transcriber(http, local);
    await transcriber.transcribe({
      wav: WAV,
      apiKey: "k",
      vocabulary: VOCABULARY,
      provider: "openai",
      language: "en",
    });
    const first = http.calls[0]!;
    expect(first.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const form = expectForm(first.request.body);
    expect(form.get("model")).toBe(DEFAULT_STT_MODELS.openai);
    expect(form.get("language")).toBe("en");
    expect(form.has("languages[]")).toBe(false);
    expect(form.has("prompt")).toBe(false);
    expect(form.has("keyterm")).toBe(false);

  });

  it("sends OpenRouter base64 JSON without vocabulary fields", async () => {
    const http = new FakeHttp();
    const transcriber = new Transcriber(http, local);
    await transcriber.transcribe({
      wav: WAV,
      apiKey: "k",
      vocabulary: VOCABULARY,
      provider: "openrouter",
      language: "en",
    });
    const call = http.calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(call.request.headers).toEqual({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
    });
    expect(typeof call.request.body).toBe("string");
    const body = JSON.parse(call.request.body as string) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_STT_MODELS.openrouter);
    expect(body.language).toBe("en");
    expect(body).not.toHaveProperty("provider");
    const inputAudio = body.input_audio as Record<string, unknown>;
    expect(inputAudio.format).toBe("wav");
    expect(Buffer.from(inputAudio.data as string, "base64")).toEqual(Buffer.from(WAV));
  });

  it("uses a keyless local multipart endpoint and collapses whitespace", async () => {
    const http = new FakeHttp();
    http.response = response(200, { text: " hello\n world \n" });
    const controller = new AbortController();
    const transcriber = new Transcriber(http, {
      async withServer(_policy, callback) {
        return await callback("http://127.0.0.1:9");
      },
    });
    expect(await transcriber.transcribe({
      wav: WAV,
      apiKey: "",
      language: "en",
      vocabulary: VOCABULARY,
      provider: "local",
      signal: controller.signal,
      timeoutMs: 10_000,
    })).toBe("hello world");
    const call = http.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:9/inference");
    expect(call.request.headers).toBeUndefined();
    expect(call.request.signal).toBe(controller.signal);
    expect(call.request.timeoutMs).toBe(10_000);
    const form = expectForm(call.request.body);
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("en");
    expect(form.has("prompt")).toBe(false);
    expect(form.has("keyterm")).toBe(false);
  });

  it("requests timestamped deterministic output for local preview", async () => {
    const http = new FakeHttp();
    http.response = response(200, {
      text: " hello world ",
      segments: [{
        tokens: [101, 102],
        words: [
          { word: " hello", start: 0.1, end: 0.4, probability: 0.9 },
          { word: " world", start: 0.5, end: 0.9, probability: 0.8 },
        ],
      }],
    });
    const transcriber = new Transcriber(http, local);
    const controller = new AbortController();

    await expect(transcriber.transcribeLocalPreview({
      wav: WAV,
      language: "en",
      prompt: "Earlier context",
      signal: controller.signal,
      timeoutMs: 10_000,
    })).resolves.toEqual({
      text: "hello world",
      tokens: [
        { id: 101, text: " hello", startSeconds: 0.1, endSeconds: 0.4 },
        { id: 102, text: " world", startSeconds: 0.5, endSeconds: 0.9 },
      ],
    });

    const request = http.calls[0]!.request;
    expect(request.signal).toBe(controller.signal);
    expect(request.timeoutMs).toBe(10_000);
    const form = expectForm(request.body);
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("prompt")).toBe("Earlier context");
    expect(form.get("temperature_inc")).toBe("0");
    expect(form.get("best_of")).toBe("1");
    expect(form.get("beam_size")).toBe("1");
    expect(form.get("token_timestamps")).toBe("true");
    expect(form.get("no_language_probabilities")).toBe("true");
  });

  it("rejects missing keys before making a request", async () => {
    const http = new FakeHttp();
    const transcriber = new Transcriber(http, local);
    await expect(transcriber.transcribe({
      wav: WAV,
      apiKey: "  ",
      provider: "openai",
      language: "en",
      vocabulary: [],
    })).rejects.toThrow(/Speech & AI/u);
    expect(http.calls).toHaveLength(0);
  });

  it("maps HTTP, invalid JSON, and connection failures to friendly errors", async () => {
    const http = new FakeHttp();
    const transcriber = new Transcriber(http, local);
    http.response = response(401, "nope", false);
    await expect(transcriber.transcribe({
      wav: WAV,
      apiKey: "bad",
      provider: "openai",
      language: "en",
      vocabulary: [],
    })).rejects.toThrow(/Invalid OpenAI API key/u);

    http.response = response(200, "not-json", false);
    await expect(transcriber.transcribe({
      wav: WAV,
      apiKey: "k",
      provider: "openai",
      language: "en",
      vocabulary: [],
    })).rejects.toThrow(/non-JSON/u);

    http.error = new Error("offline");
    await expect(transcriber.transcribe({
      wav: WAV,
      apiKey: "k",
      provider: "openrouter",
      language: "en",
      vocabulary: [],
    })).rejects.toBeInstanceOf(TranscriptionError);
  });
});

function response(status: number, value: unknown, encode = true): HttpResponse {
  const body = encode ? JSON.stringify(value) : String(value);
  return { status, body };
}

function expectForm(body: BodyInit): FormData {
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}
