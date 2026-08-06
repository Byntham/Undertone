import { describe, expect, it } from "vitest";

import { ProviderModelCatalog } from "../src/core/providerModels";
import type { HttpGetClient, HttpGetRequest, HttpResponse } from "../src/platform/http";

class FakeGet implements HttpGetClient {
  readonly requests: Array<{ url: string; request: HttpGetRequest }> = [];
  readonly responses: HttpResponse[] = [];

  async get(url: string, request: HttpGetRequest): Promise<HttpResponse> {
    this.requests.push({ url, request });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake response configured");
    return response;
  }
}

describe("provider model catalog", () => {
  it("filters OpenAI transcription models and caches successful responses", async () => {
    const http = new FakeGet();
    http.responses.push(
      response({ data: [
        { id: "gpt-4o-mini" },
        { id: "gpt-4o-mini-transcribe" },
        { id: "gpt-4o-transcribe-diarize" },
        { id: "whisper-1" },
      ] }),
      response({ data: [{ id: "gpt-transcribe" }] }),
    );
    const catalog = new ProviderModelCatalog(http);
    const first = await catalog.list("openai", "stt", "secret");
    expect(first.models.map(({ id }) => id)).toEqual([
      "gpt-4o-mini-transcribe",
      "gpt-4o-transcribe-diarize",
      "whisper-1",
    ]);
    expect(first.defaultModel).toBe("gpt-4o-mini-transcribe");
    expect(await catalog.list("openai", "stt", "secret")).toBe(first);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.request.headers).toEqual({ Authorization: "Bearer secret" });
    expect((await catalog.list("openai", "stt", "secret", true)).models[0]?.id)
      .toBe("gpt-transcribe");
    expect(http.requests).toHaveLength(2);
  });

  it("does not maintain an OpenAI cleanup-model denylist", async () => {
    const http = new FakeGet();
    http.responses.push(response({ data: [
      { id: "gpt-5.6-sol" },
      { id: "gpt-4o-mini" },
      { id: "o3-mini" },
      { id: "gpt-4o-realtime-preview" },
      { id: "gpt-image-2" },
      { id: "text-embedding-3-small" },
    ] }));
    const result = await new ProviderModelCatalog(http).list("openai", "cleanup", "secret");
    expect(result.models.map(({ id }) => id)).toEqual([
      "gpt-4o-mini",
      "gpt-4o-realtime-preview",
      "gpt-5.6-sol",
      "gpt-image-2",
      "o3-mini",
      "text-embedding-3-small",
    ]);
  });

  it("uses xAI language models for cleanup and treats xAI STT as provider-managed", async () => {
    const http = new FakeGet();
    const catalog = new ProviderModelCatalog(http);
    const stt = await catalog.list("xai", "stt", "");
    expect(stt).toMatchObject({ selectable: false, defaultModel: null, models: [] });
    expect(http.requests).toHaveLength(0);

    http.responses.push(response({ models: [{
      id: "grok-4.20",
      aliases: ["grok-latest", "grok-4.20"],
    }] }));
    const cleanup = await catalog.list("xai", "cleanup", "secret");
    expect(cleanup.models.map(({ id }) => id)).toEqual(["grok-4.20", "grok-latest"]);
    expect(http.requests[0]?.url).toBe("https://api.x.ai/v1/language-models");
  });

  it("uses OpenRouter capability metadata for cleanup and its transcription filter", async () => {
    const http = new FakeGet();
    http.responses.push(
      response({ data: [
        openRouterModel("chat/compatible", ["text"], ["text"], ["response_format"]),
        openRouterModel("chat/no-json", ["text"], ["text"], ["temperature"]),
      ] }),
      response({ data: [
        openRouterModel("audio/transcriber", ["audio"], ["transcription"], []),
      ] }),
    );
    const catalog = new ProviderModelCatalog(http);
    expect((await catalog.list("openrouter", "cleanup", "secret")).models.map(({ id }) => id))
      .toEqual(["chat/compatible"]);
    expect(http.requests[0]?.url).toBe("https://openrouter.ai/api/v1/models/user");
    expect((await catalog.list("openrouter", "stt", "secret")).models.map(({ id }) => id))
      .toEqual(["audio/transcriber"]);
    expect(http.requests[1]?.url)
      .toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
  });

  it("does not cache failures and reports missing or rejected keys clearly", async () => {
    const http = new FakeGet();
    const catalog = new ProviderModelCatalog(http);
    await expect(catalog.list("openai", "cleanup", "")).rejects.toThrow(/Save the OpenAI API key/u);
    http.responses.push({ status: 401, body: "{}" }, response({ data: [] }));
    await expect(catalog.list("openai", "cleanup", "bad")).rejects.toThrow(/rejected/u);
    await expect(catalog.list("openai", "cleanup", "good")).resolves.toMatchObject({ models: [] });
    expect(http.requests).toHaveLength(2);
  });
});

function response(payload: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(payload) };
}

function openRouterModel(
  id: string,
  inputModalities: string[],
  outputModalities: string[],
  supportedParameters: string[],
): Record<string, unknown> {
  return {
    id,
    name: id,
    architecture: {
      input_modalities: inputModalities,
      output_modalities: outputModalities,
    },
    supported_parameters: supportedParameters,
  };
}
