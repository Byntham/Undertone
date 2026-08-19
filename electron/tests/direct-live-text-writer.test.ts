import { describe, expect, it, vi } from "vitest";

import { DirectLiveTextWriter } from "../src/core/directLiveTextWriter";

describe("direct live text writer", () => {
  it("serializes growing hypotheses and adds final punctuation and spacing", async () => {
    const inserted: string[] = [];
    const writer = new DirectLiveTextWriter(async (text) => {
      inserted.push(text);
      return true;
    }, vi.fn(), async () => undefined);

    writer.update("Hello");
    writer.update("Hello world");
    await writer.finish("Hello world.");

    expect(inserted).toEqual(["Hello", " world. "]);
  });

  it("does not try to rewrite a revised hypothesis, but keeps inserting new growth", async () => {
    const inserted: string[] = [];
    const writer = new DirectLiveTextWriter(async (text) => {
      inserted.push(text);
      return true;
    }, vi.fn(), async () => undefined);

    writer.update("hello wor");
    writer.update("yellow world");
    writer.update("yellow world today");
    await writer.finish("yellow world today.");

    expect(inserted).toEqual(["hello wor", " today. "]);
  });

  it("reports an insertion failure once", async () => {
    const failed = vi.fn();
    const writer = new DirectLiveTextWriter(
      async () => false,
      failed,
      async () => undefined,
    );
    writer.update("Hello");

    await expect(writer.finish("Hello world")).rejects.toThrow("did not accept");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("does not add a second space when the final transcript trims a partial", async () => {
    const inserted: string[] = [];
    const writer = new DirectLiveTextWriter(async (text) => {
      inserted.push(text);
      return true;
    }, vi.fn(), async () => undefined);
    writer.update("Hello ");

    await writer.finish("Hello");

    expect(inserted).toEqual(["Hello "]);
  });

  it("drops queued writes after cancellation", async () => {
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    const inserted: string[] = [];
    const writer = new DirectLiveTextWriter(async (text) => {
      inserted.push(text);
      await firstWrite;
      return true;
    }, vi.fn(), async () => undefined);
    writer.update("Hello");
    await vi.waitFor(() => expect(inserted).toEqual(["Hello"]));
    writer.update("Hello world");

    writer.cancel();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inserted).toEqual(["Hello"]);
  });
});
