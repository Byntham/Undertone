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
  captureId: number;
  streamLive: boolean;
  retainAudio: boolean;
  input: AudioInput;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  sink: GainNode;
  chunks: Float32Array[];
  streamChunks: Float32Array[];
  startedAt: number;
}

interface AudioInput {
  context: AudioContext;
  stream: MediaStream;
  close: () => Promise<void>;
}

let session: CaptureSession | null = null;
let operations = Promise.resolve();
let cueContext: AudioContext | null = null;

window.undertoneAudio.onCommand((command) => {
  operations = operations.then(async () => {
    if (command.type === "cue") {
      try {
        playCue(command.name);
      } catch {
        // Cues are optional feedback and must never affect capture commands.
      }
    }
    else if (command.type === "start") {
      await startCapture(
        command.deviceName ?? "",
        command.captureId,
        command.stream,
        command.retain,
      );
    }
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
    else if (command.type === "stop") await stopCapture(false, command.requestId);
    else if (command.type === "cancel") await stopCapture(true);
  }).catch((error: unknown) => {
    window.undertoneAudio.emit({
      type: "error",
      ...(command.type === "stop" ? { requestId: command.requestId } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

function playCue(name: "start" | "stop" | "lock" | "cancel"): void {
  const context = cueContext ??= new AudioContext({ latencyHint: "interactive" });
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
  gain.connect(context.destination);
  const frequencies = name === "lock" ? [620, 820] : [name === "start" ? 760 : 520];
  let playing = frequencies.length;
  for (const [index, frequency] of frequencies.entries()) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      playing -= 1;
      if (playing === 0) gain.disconnect();
    }, { once: true });
    oscillator.start(context.currentTime + index * 0.055);
    oscillator.stop(context.currentTime + 0.09 + index * 0.055);
  }
}

window.addEventListener("unload", () => {
  const context = cueContext;
  cueContext = null;
  if (context !== null) void context.close().catch(() => undefined);
});

void reportDevices("ready");
navigator.mediaDevices.addEventListener("devicechange", () => { void reportDevices("devices"); });

async function startCapture(
  deviceName: string,
  captureId: number,
  streamLive: boolean,
  retainAudio: boolean,
): Promise<void> {
  if (session !== null) return;
  const input = await openInput(deviceName);
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  const chunks: Float32Array[] = [];
  const streamChunks: Float32Array[] = [];
  try {
    const { context } = input;
    await context.audioWorklet.addModule(workletUrl);
    source = context.createMediaStreamSource(input.stream);
    worklet = new AudioWorkletNode(context, "undertone-capture");
    sink = context.createGain();
    sink.gain.value = 0;
    let streamSampleCount = 0;
    let levelSquareSum = 0;
    let levelSampleCount = 0;
    const levelWindowSamples = Math.max(1, Math.round(context.sampleRate / 20));
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data;
      if (retainAudio) chunks.push(chunk);
      if (streamLive) {
        streamChunks.push(chunk);
        streamSampleCount += chunk.length;
        if (streamSampleCount >= context.sampleRate / 10) {
          emitLiveChunk(captureId, streamChunks, context.sampleRate);
          streamChunks.length = 0;
          streamSampleCount = 0;
        }
      }
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
    session = {
      captureId,
      streamLive,
      retainAudio,
      input,
      source,
      worklet,
      sink,
      chunks,
      streamChunks,
      startedAt: performance.now(),
    };
  } catch (error) {
    releaseGraph(source, worklet, sink);
    await input.close();
    throw error;
  }
  await reportDevices("devices");
}

async function measureMicrophone(deviceName: string): Promise<number> {
  if (session !== null) throw new Error("A dictation is already recording");
  const input = await openInput(deviceName);
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  try {
    source = input.context.createMediaStreamSource(input.stream);
    analyser = input.context.createAnalyser();
    analyser.fftSize = 1_024;
    source.connect(analyser);
    await input.context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let index = 0; index < 20; index += 1) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return Math.min(1, peak);
  } finally {
    disconnect(source);
    disconnect(analyser);
    await input.close();
  }
}

async function openInput(deviceName: string): Promise<AudioInput> {
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
  let context: AudioContext;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
  } catch (error) {
    stopStream(stream);
    throw error;
  }
  let closed = false;
  return {
    context,
    stream,
    close: async () => {
      if (closed) return;
      closed = true;
      stopStream(stream);
      try {
        await context.close();
      } catch {
        // The tracks are already stopped; a failed close has no recovery path.
      }
    },
  };
}

async function reportDevices(type: "ready" | "devices"): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const names = [...new Set(devices
    .filter((device) => device.kind === "audioinput" && device.label.trim().length > 0)
    .map((device) => device.label.trim()))].sort((left, right) => left.localeCompare(right));
  window.undertoneAudio.emit({ type, devices: names });
}

async function stopCapture(discard: boolean, requestId?: number): Promise<void> {
  const active = session;
  if (active === null) return;
  session = null;
  releaseGraph(active.source, active.worklet, active.sink);
  await active.input.close();

  if (discard) return;
  const durationMs = Math.round(performance.now() - active.startedAt);
  if (active.streamLive) {
    emitLiveChunk(active.captureId, active.streamChunks, active.input.context.sampleRate);
    if (!active.retainAudio && requestId !== undefined) {
      window.undertoneAudio.emit({ type: "stopped", requestId, durationMs });
    }
    if (!active.retainAudio) return;
  }
  const sourceSamples = joinFloat32(active.chunks);
  const samples = resampleLinear(sourceSamples, active.input.context.sampleRate, 16_000);
  const wav = encodePcm16Wav(samples, 16_000);
  if (requestId === undefined) return;
  window.undertoneAudio.emit({ type: "stopped", requestId, wav, durationMs });
}

function releaseGraph(
  source: MediaStreamAudioSourceNode | undefined,
  worklet: AudioWorkletNode | undefined,
  sink: GainNode | undefined,
): void {
  if (worklet !== undefined) {
    try {
      worklet.port.onmessage = null;
      worklet.port.close();
    } catch {
      // Continue releasing the rest of the audio graph.
    }
  }
  disconnect(source);
  disconnect(worklet);
  disconnect(sink);
}

function disconnect(node: AudioNode | undefined): void {
  try {
    node?.disconnect();
  } catch {
    // Continue releasing the rest of the audio graph.
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue stopping the remaining tracks.
    }
  }
}

function emitLiveChunk(
  captureId: number,
  chunks: readonly Float32Array[],
  sampleRate: number,
): void {
  if (chunks.length === 0) return;
  const samples = joinFloat32(chunks);
  window.undertoneAudio.emit({
    type: "chunk",
    captureId,
    samples: samples.buffer as ArrayBuffer,
    sampleRate,
  });
}
