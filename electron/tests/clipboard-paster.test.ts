import { describe, expect, it } from "vitest";

import { ClipboardPaster, type ClipboardAdapter } from "../src/core/clipboardPaster";

class MemoryClipboard implements ClipboardAdapter {
  constructor(public value: string) {}
  readText(): string { return this.value; }
  writeText(value: string): void { this.value = value; }
}

describe("clipboard paster", () => {
  it("writes, waits for propagation, sends paste, and restores later", async () => {
    const clipboard = new MemoryClipboard("previous");
    const waits: number[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const paster = new ClipboardPaster(
      clipboard,
      { async sendPaste() { return true; } },
      async (milliseconds) => { waits.push(milliseconds); },
      (callback, milliseconds) => {
        expect(milliseconds).toBe(500);
        scheduled.push(callback);
      },
    );
    await paster.paste("dictated text");
    expect(waits).toEqual([150]);
    expect(clipboard.value).toBe("dictated text");
    await scheduled[0]!();
    expect(clipboard.value).toBe("previous");
  });

  it("does not let an older restore overwrite a newer paste", async () => {
    const clipboard = new MemoryClipboard("original");
    const scheduled: Array<() => Promise<void>> = [];
    const paster = new ClipboardPaster(
      clipboard,
      { async sendPaste() { return true; } },
      async () => undefined,
      (callback) => { scheduled.push(callback); },
    );
    await paster.paste("first");
    await paster.paste("second");
    await scheduled[0]!();
    expect(clipboard.value).toBe("second");
    await scheduled[1]!();
    expect(clipboard.value).toBe("first");
  });

  it("preserves a user clipboard change made before restoration", async () => {
    const clipboard = new MemoryClipboard("previous");
    const scheduled: Array<() => Promise<void>> = [];
    const paster = new ClipboardPaster(
      clipboard,
      { async sendPaste() { return true; } },
      async () => undefined,
      (callback) => { scheduled.push(callback); },
    );
    await paster.paste("dictated text");
    clipboard.value = "user copied this";
    await scheduled[0]!();
    expect(clipboard.value).toBe("user copied this");
  });

  it("invalidates pending restoration when text is parked as a fallback", async () => {
    const clipboard = new MemoryClipboard("previous");
    const scheduled: Array<() => Promise<void>> = [];
    const paster = new ClipboardPaster(
      clipboard,
      { async sendPaste() { return true; } },
      async () => undefined,
      (callback) => { scheduled.push(callback); },
    );
    await paster.paste("first");
    paster.copyFallback("safe fallback");
    await scheduled[0]!();
    expect(clipboard.value).toBe("safe fallback");
  });

  it("reports paste injection failure while leaving text recoverable", async () => {
    const clipboard = new MemoryClipboard("previous");
    const paster = new ClipboardPaster(
      clipboard,
      { async sendPaste() { return false; } },
      async () => undefined,
    );
    await expect(paster.paste("dictated text")).rejects.toThrow(/paste keystroke/u);
    expect(clipboard.value).toBe("dictated text");
  });

  it("does nothing for empty text", async () => {
    const clipboard = new MemoryClipboard("previous");
    let sent = false;
    const paster = new ClipboardPaster(clipboard, {
      async sendPaste() { sent = true; return true; },
    });
    await paster.paste("");
    expect(sent).toBe(false);
    expect(clipboard.value).toBe("previous");
  });
});
