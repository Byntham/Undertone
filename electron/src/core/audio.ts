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

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
