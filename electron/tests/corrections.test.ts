import { describe, expect, it } from "vitest";

import { applyCorrections, finalizeTranscript } from "../src/core/corrections";

describe("transcript corrections", () => {
  it("trims isolated transcripts", () => {
    expect(finalizeTranscript("  Hello world.  ", {})).toBe("Hello world.");
  });

  it("applies corrections once with word boundaries and casing", () => {
    const corrections = { "under tone": "Undertone", asap: "ASAP" };
    expect(applyCorrections("the under tone app", corrections)).toBe("the Undertone app");
    expect(applyCorrections("UNDER TONE", corrections)).toBe("UNDERTONE");
    expect(applyCorrections("do it asap", corrections)).toBe("do it ASAP");
    expect(applyCorrections("thunderstorm", { under: "over" })).toBe("thunderstorm");
    expect(applyCorrections("Under Tone", corrections)).toBe("Undertone");
    expect(applyCorrections("i like c++", { "c++": "C++" })).toBe("i like C++");
    expect(applyCorrections("C++17 is current", { "c++": "C Plus Plus" }))
      .toBe("C++17 is current");
    expect(applyCorrections("under tone", {
      "under tone": "Undertone",
      undertone: "Product",
    })).toBe("Undertone");
    expect(applyCorrections("Iphone", { iphone: "iPhone" })).toBe("iPhone");
  });

  it("applies corrections before trimming", () => {
    expect(finalizeTranscript("  under tone  ", { "under tone": "Undertone" }))
      .toBe("Undertone");
  });
});
