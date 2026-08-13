import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioCommand, AudioEvent } from "../src/preload/audioPreload";

class FakeAudioNode {
  readonly disconnect = vi.fn();

  connect<T extends AudioNode>(node: T): T {
    return node;
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static readonly instances: FakeAudioWorkletNode[] = [];

  readonly port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
    close: vi.fn(),
  };

  constructor() {
    super();
    FakeAudioWorkletNode.instances.push(this);
  }
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];
  static failConstruction = false;
  static failResume = false;
  static failWorklet = false;

  readonly audioWorklet = {
    addModule: vi.fn(async () => {
      if (FakeAudioContext.failWorklet) throw new Error("worklet failed");
    }),
  };
  readonly close = vi.fn(async () => undefined);
  readonly createAnalyser = vi.fn(() => Object.assign(new FakeAudioNode(), {
    fftSize: 0,
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.1)),
  }));
  readonly createGain = vi.fn(() => Object.assign(new FakeAudioNode(), {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
  }));
  readonly createMediaStreamSource = vi.fn(() => new FakeAudioNode());
  readonly createOscillator = vi.fn(() => {
    let endedListener: EventListenerOrEventListenerObject | undefined;
    const finish = vi.fn(() => {
      const event = { type: "ended" } as Event;
      if (typeof endedListener === "function") endedListener(event);
      else endedListener?.handleEvent(event);
    });
    return Object.assign(new FakeAudioNode(), {
      type: "sine",
      frequency: { value: 0 },
      addEventListener: vi.fn((
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (type === "ended") endedListener = listener;
      }),
      start: vi.fn(),
      stop: vi.fn(),
      finish,
    });
  });
  readonly currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly resume = vi.fn(async () => {
    if (FakeAudioContext.failResume) throw new Error("resume failed");
  });
  readonly sampleRate = 48_000;
  readonly state = "running";

  constructor() {
    if (FakeAudioContext.failConstruction) throw new Error("context failed");
    FakeAudioContext.instances.push(this);
  }
}

describe("audio renderer resource ownership", () => {
  let commandListener: ((command: AudioCommand) => void) | undefined;
  let emit: ReturnType<typeof vi.fn<(event: AudioEvent) => void>>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let stopTrack: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    FakeAudioContext.instances.length = 0;
    FakeAudioWorkletNode.instances.length = 0;
    FakeAudioContext.failConstruction = false;
    FakeAudioContext.failResume = false;
    FakeAudioContext.failWorklet = false;
    emit = vi.fn<(event: AudioEvent) => void>();
    stopTrack = vi.fn();
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => [{
          deviceId: "selected-id",
          kind: "audioinput",
          label: "Selected microphone",
        }]),
        getUserMedia,
      },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      undertoneAudio: {
        emit,
        onCommand: (listener: (command: AudioCommand) => void) => {
          commandListener = listener;
          return () => undefined;
        },
      },
    });
    await import("../src/renderer/audio/audio.js");
    await flushPromises();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves command order when an earlier capture start is deferred", async () => {
    let resolveStream!: (stream: { getTracks: () => { stop: typeof stopTrack }[] }) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();
    commandListener?.({ type: "cue", name: "start" });
    await flushPromises();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances).toHaveLength(0);

    resolveStream({ getTracks: () => [{ stop: stopTrack }] });
    await flushPromises();

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[0]?.createMediaStreamSource).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[1]?.createOscillator).toHaveBeenCalledOnce();

    commandListener?.({ type: "cancel" });
    await flushPromises();
  });

  it("launches cues in order without waiting for their duration", async () => {
    commandListener?.({ type: "cue", name: "start" });
    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();

    const cueContext = FakeAudioContext.instances[0];
    const oscillator = cueContext?.createOscillator.mock.results[0]?.value;
    const gain = cueContext?.createGain.mock.results[0]?.value;
    expect(oscillator?.start).toHaveBeenCalledOnce();
    expect(oscillator?.stop).toHaveBeenCalledOnce();
    expect(oscillator?.disconnect).not.toHaveBeenCalled();
    expect(gain?.disconnect).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();

    oscillator?.finish();
    expect(oscillator?.disconnect).toHaveBeenCalledOnce();
    expect(gain?.disconnect).toHaveBeenCalledOnce();

    commandListener?.({ type: "cancel" });
    await flushPromises();
  });

  it("swallows cue startup errors without poisoning later commands", async () => {
    FakeAudioContext.failConstruction = true;
    commandListener?.({ type: "cue", name: "start" });
    await flushPromises();
    FakeAudioContext.failConstruction = false;

    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(getUserMedia).toHaveBeenCalledOnce();

    commandListener?.({ type: "cancel" });
    await flushPromises();
  });

  it("uses the same raw mono constraints for recording and microphone tests", async () => {
    vi.useFakeTimers();
    commandListener?.({ type: "meter", requestId: 1, deviceName: "Selected microphone" });
    await vi.runAllTimersAsync();
    await flushPromises();
    commandListener?.({
      type: "start",
      captureId: 1,
      deviceName: "Selected microphone",
      stream: false,
    });
    await flushPromises();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual(getUserMedia.mock.calls[1]?.[0]);
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: {
        autoGainControl: false,
        channelCount: 1,
        deviceId: { exact: "selected-id" },
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });

    commandListener?.({ type: "cancel" });
    await flushPromises();
  });

  it("streams live audio without retaining a batch recording", async () => {
    commandListener?.({
      type: "start",
      captureId: 8,
      deviceName: "",
      stream: true,
    });
    await flushPromises();

    const port = FakeAudioWorkletNode.instances.at(-1)?.port;
    port?.onmessage?.({ data: new Float32Array(4_800).fill(0.25) } as MessageEvent<Float32Array>);
    commandListener?.({ type: "stop", requestId: 8 });
    await flushPromises();

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "chunk",
      captureId: 8,
    }));
    expect(emit).toHaveBeenCalledWith({
      type: "stopped",
      requestId: 8,
      durationMs: expect.any(Number),
    });
  });

  it("releases the input when capture setup fails", async () => {
    FakeAudioContext.failWorklet = true;
    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances.at(-1)?.close).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({ type: "error", message: "worklet failed" });
  });

  it("releases the worklet when a later setup step fails", async () => {
    FakeAudioContext.failResume = true;
    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances.at(-1)?.close).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances.at(-1)?.port.close).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({ type: "error", message: "resume failed" });
  });

  it("stops the stream if AudioContext construction fails", async () => {
    FakeAudioContext.failConstruction = true;
    commandListener?.({ type: "start", captureId: 1, deviceName: "", stream: false });
    await flushPromises();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({ type: "error", message: "context failed" });
  });
});

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
