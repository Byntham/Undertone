import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveLocalPreviewDiagnostic } from "../src/main/localPreviewDiagnostics";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("local preview diagnostics", () => {
  it("saves audio and a shareable trace without unrelated configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "undertone-preview-diagnostic-"));
    temporaryDirectories.push(root);
    const directory = await saveLocalPreviewDiagnostic(root, {
      captureId: 7,
      createdAt: "2026-08-12T12:34:56.789Z",
      appVersion: "1.8.1",
      language: "en",
      model: "ggml-large-v3-turbo.bin",
      wav: Uint8Array.of(82, 73, 70, 70),
      previewAtStop: "preview text",
      finalTranscript: "final text",
      events: [{ type: "display", atMs: 250, text: "preview text" }],
    });

    expect(new Uint8Array(await readFile(path.join(directory, "audio.wav"))))
      .toEqual(Uint8Array.of(82, 73, 70, 70));
    const trace = JSON.parse(await readFile(path.join(directory, "trace.json"), "utf8")) as {
      finalTranscript: string;
      events: unknown[];
    };
    expect(trace.finalTranscript).toBe("final text");
    expect(trace.events).toEqual([{ type: "display", atMs: 250, text: "preview text" }]);
  });

  it("keeps only the newest ten sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "undertone-preview-diagnostic-"));
    temporaryDirectories.push(root);
    for (let index = 0; index < 12; index += 1) {
      await saveLocalPreviewDiagnostic(root, {
        captureId: index,
        createdAt: new Date(Date.UTC(2026, 7, 12, 0, 0, index)).toISOString(),
        appVersion: "1.8.1",
        language: "en",
        model: "model.bin",
        wav: Uint8Array.of(),
        previewAtStop: "",
        finalTranscript: null,
        events: [],
      });
    }

    const sessions = (await readdir(root)).sort();
    expect(sessions).toHaveLength(10);
    expect(sessions[0]).toContain("00-00-02");
    expect(sessions.at(-1)).toContain("00-00-11");
  });
});
