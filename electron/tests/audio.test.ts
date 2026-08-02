import { describe, expect, it } from "vitest";

import { encodePcm16Wav, joinFloat32, resampleLinear } from "../src/core/audio";

describe("audio conversion", () => {
  it("joins capture blocks in order", () => {
    expect(Array.from(joinFloat32([
      new Float32Array([1, 2]),
      new Float32Array([3]),
    ]))).toEqual([1, 2, 3]);
  });

  it("resamples with linear interpolation", () => {
    const result = resampleLinear(new Float32Array([0, 1, 0, -1]), 4, 8);
    expect(Array.from(result)).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
  });

  it("keeps duration when reducing to 16 kHz", () => {
    const input = new Float32Array(48_000).fill(0.25);
    const result = resampleLinear(input, 48_000, 16_000);
    expect(result).toHaveLength(16_000);
    expect(result[8_000]).toBeCloseTo(0.25);
  });

  it("encodes mono signed 16-bit PCM WAV", () => {
    const buffer = encodePcm16Wav(new Float32Array([-1, 0, 1]), 16_000);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32_767);
  });

  it("rejects invalid sample rates", () => {
    expect(() => resampleLinear(new Float32Array([1]), 0, 16_000)).toThrow();
    expect(() => encodePcm16Wav(new Float32Array([1]), 16_000.5)).toThrow();
  });
});
