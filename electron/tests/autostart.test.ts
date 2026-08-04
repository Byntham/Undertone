import { describe, expect, it } from "vitest";

import { AutostartManager, type RegistryRunner } from "../src/main/autostart";

class FakeRegistry implements RegistryRunner {
  readonly values = new Map<string, string>();
  readonly calls: string[][] = [];

  async run(arguments_: readonly string[]): Promise<number> {
    const args = [...arguments_];
    this.calls.push(args);
    const operation = args[0];
    const valueIndex = args.indexOf("/v");
    const name = valueIndex < 0 ? "" : args[valueIndex + 1] ?? "";
    if (operation === "query") return this.values.has(name) ? 0 : 1;
    if (operation === "delete") {
      const existed = this.values.delete(name);
      return existed ? 0 : 1;
    }
    if (operation === "add") {
      const dataIndex = args.indexOf("/d");
      this.values.set(name, args[dataIndex + 1] ?? "");
      return 0;
    }
    return 1;
  }
}

describe("Windows autostart", () => {
  it("reconciles the current registration to the current executable", async () => {
    const registry = new FakeRegistry();
    registry.values.set("Undertone", "stale command");
    const manager = new AutostartManager(String.raw`C:\Program Files\Undertone\Undertone.exe`, registry);
    await manager.reconcile();
    expect(registry.values.get("Undertone")).toBe(
      String.raw`"C:\Program Files\Undertone\Undertone.exe" --autostart`,
    );
    expect(await manager.isEnabled()).toBe(true);

    await manager.reconcile();
    expect([...registry.values.keys()]).toEqual(["Undertone"]);
  });

  it("does not opt a user in while reconciling and disables the current registration", async () => {
    const registry = new FakeRegistry();
    const manager = new AutostartManager("Undertone.exe", registry);
    await manager.reconcile();
    expect(registry.values.size).toBe(0);

    await manager.setEnabled(true);
    await manager.setEnabled(false);
    expect(registry.values.size).toBe(0);
  });
});
