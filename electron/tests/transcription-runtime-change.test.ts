import { describe, expect, it, vi } from "vitest";

import { settleTranscriptionRuntimeChange } from "../src/main/transcriptionRuntimeChange";

describe("transcription runtime settings changes", () => {
  it("cancels an active capture before ejecting its prior engine", async () => {
    const calls: string[] = [];
    await settleTranscriptionRuntimeChange({
      previous: {
        provider: "local",
        local_stt_engine: "nemotron",
        live_transcription: true,
      },
      next: {
        provider: "local",
        local_stt_engine: "whisper",
        live_transcription: false,
      },
      recordingActive: true,
      cancelRecording: () => { calls.push("cancel"); },
      ejectEngine: async (engine) => { calls.push(`eject:${engine}`); },
    });

    expect(calls).toEqual(["cancel", "eject:nemotron"]);
  });

  it("does not cancel an idle recording or eject an unchanged engine", async () => {
    const cancelRecording = vi.fn();
    const ejectEngine = vi.fn(async () => undefined);
    await settleTranscriptionRuntimeChange({
      previous: {
        provider: "local",
        local_stt_engine: "nemotron",
        live_transcription: true,
      },
      next: {
        provider: "local",
        local_stt_engine: "nemotron",
        live_transcription: false,
      },
      recordingActive: false,
      cancelRecording,
      ejectEngine,
    });

    expect(cancelRecording).not.toHaveBeenCalled();
    expect(ejectEngine).not.toHaveBeenCalled();
  });
});
