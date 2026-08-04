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
    else if (command.type === "meter") {
      try {
        const peak = await measureMicrophone(command.deviceName ?? "");
        window.undertoneAudio.emit({ type: "meter", requestId: command.requestId, peak });
      } catch (error) {
        window.undertoneAudio.emit({
          type: "meter",
          requestId: command.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    else if (command.type === "stop") await stopCapture(false);
    else if (command.type === "cancel") await stopCapture(true);
    else if (command.type === "cue") await playCue(command.name).catch(() => undefined);
  }).catch((error: unknown) => {
    window.undertoneAudio.emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

async function playCue(name: "start" | "stop" | "lock" | "cancel"): Promise<void> {
  const context = new AudioContext({ latencyHint: "interactive" });
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
  gain.connect(context.destination);
  const frequencies = name === "lock" ? [620, 820] : [name === "start" ? 760 : 520];
  for (const [index, frequency] of frequencies.entries()) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + index * 0.055);
    oscillator.stop(context.currentTime + 0.09 + index * 0.055);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, frequencies.length * 55 + 80));
  await context.close();
}

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
  let levelSquareSum = 0;
  let levelSampleCount = 0;
  const levelWindowSamples = Math.max(1, Math.round(context.sampleRate / 20));
  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const chunk = event.data;
    chunks.push(chunk);
    for (const sample of chunk) levelSquareSum += sample * sample;
    levelSampleCount += chunk.length;
    if (levelSampleCount >= levelWindowSamples) {
      window.undertoneAudio.emit({
        type: "level",
        rms: Math.sqrt(levelSquareSum / levelSampleCount),
      });
      levelSquareSum = 0;
      levelSampleCount = 0;
    }
  };
  source.connect(worklet).connect(sink).connect(context.destination);
  await context.resume();
  session = { context, stream, source, worklet, sink, chunks, startedAt: performance.now() };
  await reportDevices("devices");
}

async function measureMicrophone(deviceName: string): Promise<number> {
  if (session !== null) throw new Error("A dictation is already recording");
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const selected = devices.find((device) => (
    device.kind === "audioinput" && device.label === deviceName
  ));
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: selected === undefined ? true : { deviceId: { exact: selected.deviceId } },
    video: false,
  });
  const context = new AudioContext({ latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1_024;
  source.connect(analyser);
  await context.resume();
  const samples = new Float32Array(analyser.fftSize);
  let peak = 0;
  try {
    for (let index = 0; index < 20; index += 1) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await context.close();
  }
  return Math.min(1, peak);
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

  if (discard) return;
  const durationMs = Math.round(performance.now() - active.startedAt);
  const sourceSamples = joinFloat32(active.chunks);
  const samples = resampleLinear(sourceSamples, active.context.sampleRate, 16_000);
  const wav = encodePcm16Wav(samples, 16_000);
  window.undertoneAudio.emit({ type: "stopped", wav, durationMs });
}
