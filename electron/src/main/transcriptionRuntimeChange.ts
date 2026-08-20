import type { UndertoneConfig } from "../core/config";
import type { LocalSttEngineId } from "../shared/settings";

type TranscriptionRuntimeConfig = Pick<
  UndertoneConfig,
  "provider" | "local_stt_engine" | "live_transcription" | "direct_live_insert"
>;

export async function settleTranscriptionRuntimeChange(options: {
  previous: TranscriptionRuntimeConfig;
  next: TranscriptionRuntimeConfig;
  recordingActive: boolean;
  cancelRecording(): void;
  ejectEngine(engine: LocalSttEngineId): Promise<void>;
}): Promise<void> {
  const engineChanged = options.previous.local_stt_engine !== options.next.local_stt_engine;
  const transcriptionChanged = engineChanged
    || options.previous.provider !== options.next.provider
    || options.previous.live_transcription !== options.next.live_transcription
    || options.previous.direct_live_insert !== options.next.direct_live_insert;
  if (options.recordingActive && transcriptionChanged) options.cancelRecording();
  if (engineChanged) await options.ejectEngine(options.previous.local_stt_engine);
}
