import { describe, expect, it } from "vitest";

import {
  applyCorrections,
  finalize,
  formatTranscript,
  seam,
  stripChatPeriod,
  tailContext,
} from "../src/core/textproc";

const fmt = (
  text: string,
  context: string | null,
  corrections = {},
  smart = true,
): string => formatTranscript(text, context, corrections, smart);

describe("transcript formatting", () => {
  it("normalizes left spacing, casing, and transport whitespace", () => {
    expect(fmt("world", "hello")).toBe(" world");
    expect(fmt("nested", "(")).toBe("nested");
    expect(fmt("hi", "")).toBe("Hi");
    expect(fmt("keep this", null)).toBe("keep this");
    expect(fmt("line", "para\n")).toBe("Line");
    expect(fmt(", yes", "hello")).toBe(", yes");
    expect(fmt("4 apples", "I have 3")).toBe(" 4 apples");
    expect(fmt("  hello world.  ", "")).toBe("Hello world.");
    expect(fmt("  The update.  ", "I reviewed")).toBe(" the update.");
    expect(fmt("  keep this  ", null)).toBe("keep this");
    expect(fmt("hello.", "\u200b")).toBe("Hello.");
    expect(fmt("hello.", "\ufeff")).toBe("Hello.");
  });

  it("reconstructs both insertion seams", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["empty field", "", "  hello world.  ", "", "Hello world."],
      ["append to word", "Hello", "world.", "", "Hello world."],
      ["append after space", "Hello ", "world.", "", "Hello world."],
      ["after sentence", "Done. ", "next step.", "", "Done. Next step."],
      ["after paragraph", "Done.\n", "next step.", "", "Done.\nNext step."],
      ["middle no spaces", "I like", "red.", "apples.", "I like red apples."],
      ["middle left space", "I like ", "red.", "apples.", "I like red apples."],
      ["middle right space", "I like", "red.", " apples.", "I like red apples."],
      ["middle both spaces", "I like ", "red.", " apples.", "I like red apples."],
      ["replace word", "I eat ", "oranges.", " every day.", "I eat oranges every day."],
      ["before comma", "It is ", "ripe.", ", but bruised.", "It is ripe, but bruised."],
      ["opening quote", "She ", "said", "\"hello.\"", "She said \"hello.\""],
      ["contraction", "I think ", "it", "'s ready.", "I think it's ready."],
      ["URL token", "Visit https://exa", "mple", ".com", "Visit https://example.com"],
      ["path token", "Open C:\\Us", "ers", "\\graham", "Open C:\\Users\\graham"],
    ];
    for (const [name, before, raw, after, expected] of cases) {
      const insertion = finalize(raw, before, {}, { afterContext: after });
      expect(before + insertion + after, name).toBe(expected);
      expect(finalize(insertion, before, {}, { afterContext: after }), name)
        .toBe(insertion);
    }
  });

  it("handles right context and punctuation without duplication", () => {
    expect(finalize("red", "I like ", {}, { afterContext: "apples." })).toBe("red ");
    expect(finalize("red.", "I like ", {}, { afterContext: "apples." })).toBe("red ");
    expect(finalize("red.", "I like ", {}, { afterContext: " apples." })).toBe("red");
    expect(finalize("red", "I like", {}, { afterContext: " apples." })).toBe(" red");
    expect(finalize("ripe", "They are ", {}, { afterContext: ", but bruised." })).toBe("ripe");
    expect(finalize("it", "I think ", {}, { afterContext: "'s ready." })).toBe("it");
    expect(finalize("red,", "I like ", {}, { afterContext: "green apples." })).toBe("red, ");
    expect(finalize("(", "I like ", {}, { afterContext: "red apples)" })).toBe("(");
    expect(finalize("ers", "C:\\Us", {}, { afterContext: "\\graham" })).toBe("ers");
    expect(finalize("red", "I like ", {}, { afterContext: null })).toBe("red");
    expect(finalize("red", "I like ", {}, { afterContext: "" })).toBe("red");
    expect(finalize("Dr.", "I called ", {}, { afterContext: "Smith." })).toBe("Dr. ");
    expect(finalize("red,", "I like ", {}, { afterContext: ", green" })).toBe("red");
    expect(finalize("really?", "Is that ", {}, { afterContext: "?" })).toBe("really");
    expect(finalize("Wait...", "They said ", {}, { afterContext: "." })).toBe("Wait...");
    expect(finalize("Really??", "You mean ", {}, { afterContext: "?" })).toBe("Really??");
    expect(finalize("First sentence.", "Intro: ", {}, {
      afterContext: "Next sentence.",
    })).toBe("First sentence. ");
  });

  it("preserves boundary idempotence across representative inputs", () => {
    const befores = [
      null, "", "\u200b", "word", "word ", "Done.", "Done. ", "Done\n", "(",
      "he said \"", "https://exa", "C:\\Us", "I like ", "Intro: ",
    ];
    const raws = [
      " hello. ", " The update. ", "red.", "red,", "really?", "\"hello\"",
      "'s ready", "mple", "ers", "Dr.", "Wait...", "Really??", "  iPhone works  ",
    ];
    const afters = [
      null, "", "\u200b", "word", " word", "apples.", " apples.", ", next", ".",
      "?", "Next sentence.", "\"hello\"", "'s ready", ".com", "\\graham",
    ];
    for (const before of befores) {
      for (const raw of raws) {
        for (const afterContext of afters) {
          const output = finalize(raw, before, {}, { afterContext });
          expect(finalize(output, before, {}, { afterContext })).toBe(output);
          expect(output).not.toMatch(/^(?:[\t\r\n]| {2})/u);
          expect(output).not.toMatch(/(?:[\t\r\n]| {2})$/u);
        }
      }
    }
  });

  it("detects real token continuations conservatively", () => {
    expect(fmt("mple.com", "check https://exa")).toBe("mple.com");
    expect(fmt("cache", "see src/main")).toBe("cache");
    expect(fmt("cache", "in C:\\Users\\g")).toBe("cache");
    expect(fmt("com", "mail me@site.")).toBe("com");
    expect(fmt("mple.com", "email me@exa")).toBe("mple.com");
    expect(fmt("/api", "hit localhost:8080")).toBe("/api");
    expect(fmt("\\Users", "C:")).toBe("\\Users");
    expect(fmt("about this", "ping @graham")).toBe(" about this");
    expect(fmt("in the afternoon", "the time is 12:30")).toBe(" in the afternoon");
    expect(fmt("overall", "the ratio is 3:1")).toBe(" overall");
    expect(fmt("happened", "on 9/11")).toBe(" happened");
    expect(fmt("next step", "Agenda:")).toBe(" next step");
  });

  it("matches sentence-start and abbreviation capitalization", () => {
    expect(fmt("The cat", "I saw")).toBe(" the cat");
    expect(fmt("Graham left", "I saw")).toBe(" Graham left");
    expect(fmt("I think so", "yes and")).toBe(" I think so");
    expect(fmt("hello", "")).toBe("Hello");
    expect(fmt("things", "for e.g.")).toBe(" things");
    expect(fmt("smith", "spoke to Dr.")).toBe(" smith");
    expect(fmt("economy is strong", "in the U.S.")).toBe(" economy is strong");
    expect(fmt("tomorrow", "at 9 a.m.")).toBe(" tomorrow");
    expect(fmt("hello", "Done.")).toBe(" Hello");
    expect(fmt("kennedy spoke", "ask John F.")).toBe(" kennedy spoke");
    expect(fmt("it was great", "I got an A.")).toBe(" It was great");
    expect(fmt("then we left", "there are 3.")).toBe(" Then we left");
    expect(fmt("and then", "please wait...")).toBe(" and then");
    expect(fmt("élan matters", "")).toBe("Élan matters");
    expect(fmt("iPhone works", "")).toBe("iPhone works");
  });

  it("distinguishes opening, closing, and contraction quotes", () => {
    expect(fmt("\"hello\" she said", "he said")).toBe(" \"hello\" she said");
    expect(fmt("\"hello\" she said", "Done.")).toBe(" \"Hello\" she said");
    expect(fmt("car arrived", "James'")).toBe(" car arrived");
    expect(fmt("hello", "he said \"")).toBe("hello");
    expect(fmt("'s ready", "it")).toBe("'s ready");
    expect(fmt("next", "he said \"stop.\"")).toBe(" Next");
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
    expect(applyCorrections("İstanbul is big", { i: "I" })).toBe("İstanbul is big");
    expect(applyCorrections("under tone", {
      "under tone": "Undertone",
      undertone: "Product",
    })).toBe("Undertone");
    expect(applyCorrections("Iphone", { iphone: "iPhone" })).toBe("iPhone");
  });

  it("removes only conversational trailing periods", () => {
    expect(stripChatPeriod("See you soon.")).toBe("See you soon");
    expect(stripChatPeriod("One. Two. Three.")).toBe("One. Two. Three.");
    expect(stripChatPeriod("Wait...")).toBe("Wait...");
    expect(stripChatPeriod("I need milk, eggs, etc.")).toBe("I need milk, eggs, etc.");
    expect(stripChatPeriod("Ask Dr.")).toBe("Ask Dr.");
    expect(stripChatPeriod("See you at 3.")).toBe("See you at 3");
    expect(stripChatPeriod("It is 3.5 now.")).toBe("It is 3.5 now");
    expect(stripChatPeriod("See you. ")).toBe("See you ");
  });

  it("keeps AI body casing while enforcing deterministic seams and corrections", () => {
    expect(seam("the fix works", "I checked and")).toBe(" the fix works");
    expect(seam("hello there", "Done.")).toBe(" Hello there");
    expect(seam("  padded", "word")).toBe(" padded");
    expect(seam("anything", null)).toBe("anything");
    expect(seam("Kept As Is", "I saw")).toBe(" Kept As Is");
    expect(seam("\"hello\"", "Done.")).toBe(" \"Hello\"");
    expect(finalize("the under tone app", "Done.", { "under tone": "Undertone" }, {
      modelCased: true,
    })).toBe(" The Undertone app");
    expect(finalize("Kept As Is", "I saw", {}, { modelCased: true }))
      .toBe(" Kept As Is");
  });

  it("returns bounded insertion memory tails", () => {
    expect(tailContext("abcdef", 3)).toBe("def");
    expect(tailContext("", 3)).toBe("");
  });
});
