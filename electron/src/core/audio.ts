const WAV_HEADER_BYTES = 44;

export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate <= 0 || outputRate <= 0) {
    throw new Error("Sample rates must be positive");
  }
  if (input.length === 0 || inputRate === outputRate) {
    return input.slice();
  }

  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const step = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * step;
    const left = Math.min(Math.floor(sourceIndex), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = sourceIndex - left;
    output[index] = input[left]! * (1 - fraction) + input[right]! * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Sample rate must be a positive integer");
  }
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(WAV_HEADER_BYTES + index * 2, pcm, true);
  }
  return buffer;
}

export function joinFloat32(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, pcm, true);
  }
  return bytes;
}

/** Stateful linear resampler for successive live-capture blocks. */
export class StreamingPcm16Encoder {
  private inputRate: number | null = null;
  private buffered: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private bufferStart = 0;
  private nextOutputPosition = 0;
  private finished = false;

  constructor(readonly outputRate: number) {
    if (!Number.isInteger(outputRate) || outputRate <= 0) {
      throw new Error("Output sample rate must be a positive integer");
    }
  }

  append(samples: Float32Array, inputRate: number): Uint8Array {
    if (this.finished) throw new Error("The streaming audio encoder is finished");
    if (!Number.isInteger(inputRate) || inputRate <= 0) {
      throw new Error("Input sample rate must be a positive integer");
    }
    if (this.inputRate !== null && this.inputRate !== inputRate) {
      throw new Error("Input sample rate changed during capture");
    }
    this.inputRate = inputRate;
    this.buffered = appendFloat32(this.buffered, samples);
    return encodePcm16(this.takeAvailable(false));
  }

  finish(): Uint8Array {
    if (this.finished) return new Uint8Array(0);
    this.finished = true;
    return encodePcm16(this.takeAvailable(true));
  }

  private takeAvailable(flush: boolean): Float32Array {
    const inputRate = this.inputRate;
    if (inputRate === null || this.buffered.length === 0) return new Float32Array(0);
    const step = inputRate / this.outputRate;
    const end = this.bufferStart + this.buffered.length;
    const output: number[] = [];
    const limit = flush ? end : end - 1;
    while (this.nextOutputPosition < limit) {
      const relative = this.nextOutputPosition - this.bufferStart;
      const left = Math.max(0, Math.min(Math.floor(relative), this.buffered.length - 1));
      const right = Math.min(left + 1, this.buffered.length - 1);
      const fraction = relative - Math.floor(relative);
      output.push(this.buffered[left]! * (1 - fraction) + this.buffered[right]! * fraction);
      this.nextOutputPosition += step;
    }
    const consumed = Math.max(0, Math.min(
      Math.floor(this.nextOutputPosition) - this.bufferStart,
      this.buffered.length,
    ));
    if (consumed > 0) {
      this.buffered = this.buffered.slice(consumed);
      this.bufferStart += consumed;
    }
    return Float32Array.from(output);
  }
}

function appendFloat32(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const joined = new Float32Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
