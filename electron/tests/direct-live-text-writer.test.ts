import { describe, expect, it, vi } from "vitest";

import { DirectLiveTextWriter } from "../src/core/directLiveTextWriter";

describe("direct live text writer", () => {
  it("serializes stable text and adds an eligible final suffix and space", async () => {
    const inserted: string[] = [];
    const writer = makeWriter(inserted);

    writer.append("Hello");
    writer.append(" world");
    const result = await writer.finish("Hello world.");

    expect(inserted.join("")).toBe("Hello world. ");
    expect(result).toMatchObject({
      insertedText: "Hello world.",
      finalText: "Hello world.",
      complete: true,
      stopReason: null,
    });
  });

  it("never rewrites inserted text when the provider final diverges", async () => {
    const inserted: string[] = [];
    const stopped = vi.fn();
    const writer = new DirectLiveTextWriter(
      async (text) => { inserted.push(text); return "inserted"; },
      vi.fn(),
      stopped,
      async () => undefined,
    );
    writer.append("hello wor");

    const result = await writer.finish("yellow world");

    expect(inserted.join("")).toBe("hello wor");
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("final-mismatch");
    expect(stopped).toHaveBeenCalledWith("final-mismatch");
  });

  it("can replace only the differing final tail when the development flag enables it", async () => {
    const inserted: string[] = [];
    const replace = vi.fn(async () => "inserted" as const);
    const writer = makeWriter(inserted);
    writer.enableTailCorrection(replace);
    writer.append("hello war");

    const result = await writer.finish("hello world.");

    expect(replace).toHaveBeenCalledWith(2, "orld. ");
    expect(result).toMatchObject({ insertedText: "hello world.", complete: true });
  });

  it("stops future insertion when the guarded target changes", async () => {
    const writer = new DirectLiveTextWriter(
      async () => "focus-changed",
      vi.fn(),
      vi.fn(),
      async () => undefined,
    );
    writer.append("Hello");
    await vi.waitFor(() => expect(writer.snapshot().stopReason).toBe("focus-changed"));
    writer.append(" world");

    const result = await writer.finish("Hello world");
    expect(result.insertedText).toBe("");
    expect(result.complete).toBe(false);
  });

  it("reports an insertion failure once", async () => {
    const failed = vi.fn();
    const writer = new DirectLiveTextWriter(
      async () => false,
      failed,
      vi.fn(),
      async () => undefined,
    );
    writer.append("Hello");

    await expect(writer.finish("Hello world")).rejects.toThrow("did not accept");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("does not add a second space when the final transcript trims stable text", async () => {
    const inserted: string[] = [];
    const writer = makeWriter(inserted);
    writer.append("Hello ");

    const result = await writer.finish("Hello");

    expect(inserted.join("")).toBe("Hello ");
    expect(result.complete).toBe(true);
  });

  it("drops queued writes after cancellation", async () => {
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    const inserted: string[] = [];
    const writer = new DirectLiveTextWriter(async (text) => {
      inserted.push(text);
      await firstWrite;
      return true;
    }, vi.fn(), vi.fn(), async () => undefined);
    writer.append("Hello");
    await vi.waitFor(() => expect(inserted).toEqual(["Hello"]));
    writer.append(" world");

    writer.cancel();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inserted).toEqual(["Hello"]);
  });
});

function makeWriter(inserted: string[]): DirectLiveTextWriter {
  return new DirectLiveTextWriter(
    async (text) => { inserted.push(text); return "inserted"; },
    vi.fn(),
    vi.fn(),
    async () => undefined,
  );
}
