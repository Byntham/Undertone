import workletUrl from "./captureWorklet.ts?worker&url";

import { encodePcm16Wav, joinFloat32, resampleLinear } from "../../core/audio";
import type { AudioCommand, AudioEvent } from "../../preload/audioPreload";

declare global {
  interface Window {
    undertoneAudio: {
      onCommand: (listener: (command: AudioCommand) => void) => () => void;
      emit: (event: AudioEvent) => void;
    };
  }
}

interface CaptureSession {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  sink: GainNode;
  chunks: Float32Array[];
  startedAt: number;
}

let session: CaptureSession | null = null;
let operations = Promise.resolve();

window.undertoneAudio.onCommand((command) => {
  operations = operations.then(async () => {
    if (command.type === "start") await startCapture(command.deviceName ?? "");
    else if (command.type === "stop") await stopCapture(false);
    else await stopCapture(true);
  }).catch((error: unknown) => {
    window.undertoneAudio.emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

void reportDevices("ready");
navigator.mediaDevices.addEventListener("devicechange", () => { void reportDevices("devices"); });

async function startCapture(deviceName: string): Promise<void> {
  if (session !== null) return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const selected = devices.find((device) => (
    device.kind === "audioinput" && device.label === deviceName
  ));
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(selected === undefined ? {} : { deviceId: { exact: selected.deviceId } }),
    },
    video: false,
  });
  const context = new AudioContext({ latencyHint: "interactive" });
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "undertone-capture");
  const sink = context.createGain();
  sink.gain.value = 0;
  const chunks: Float32Array[] = [];
  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    chunks.push(event.data);
  };
  source.connect(worklet).connect(sink).connect(context.destination);
  await context.resume();
  session = { context, stream, source, worklet, sink, chunks, startedAt: performance.now() };
  window.undertoneAudio.emit({ type: "started", sampleRate: context.sampleRate });
  await reportDevices("devices");
}

async function reportDevices(type: "ready" | "devices"): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const names = [...new Set(devices
    .filter((device) => device.kind === "audioinput" && device.label.trim().length > 0)
    .map((device) => device.label.trim()))].sort((left, right) => left.localeCompare(right));
  window.undertoneAudio.emit({ type, devices: names });
}

async function stopCapture(discard: boolean): Promise<void> {
  const active = session;
  if (active === null) return;
  session = null;
  active.source.disconnect();
  active.worklet.disconnect();
  active.sink.disconnect();
  for (const track of active.stream.getTracks()) track.stop();
  await active.context.close();

  if (discard) {
    window.undertoneAudio.emit({ type: "cancelled" });
    return;
  }
  const durationMs = Math.round(performance.now() - active.startedAt);
  const sourceSamples = joinFloat32(active.chunks);
  const samples = resampleLinear(sourceSamples, active.context.sampleRate, 16_000);
  const wav = encodePcm16Wav(samples, 16_000);
  window.undertoneAudio.emit({ type: "stopped", wav, durationMs });
}
