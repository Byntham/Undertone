import { execFile } from "node:child_process";

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const VALUE_NAME = "Undertone";
const LEGACY_VALUE_NAME = "PushToTalkSTT";

export interface RegistryRunner {
  run(arguments_: readonly string[]): Promise<number>;
}

export class AutostartManager {
  constructor(
    private readonly executable: string,
    private readonly runner: RegistryRunner = new RegExeRunner(),
  ) {}

  async reconcile(): Promise<void> {
    const [current, legacy] = await Promise.all([
      this.valueExists(VALUE_NAME),
      this.valueExists(LEGACY_VALUE_NAME),
    ]);
    if (legacy) await this.deleteValue(LEGACY_VALUE_NAME);
    if (current || legacy) await this.setEnabled(true);
  }

  async isEnabled(): Promise<boolean> {
    return await this.valueExists(VALUE_NAME);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.deleteValue(VALUE_NAME);
      await this.deleteValue(LEGACY_VALUE_NAME);
      return;
    }
    const command = `"${this.executable}" --autostart`;
    const code = await this.runner.run([
      "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", command, "/f",
    ]);
    if (code !== 0) throw new Error("Could not enable Start with Windows");
  }

  private async valueExists(name: string): Promise<boolean> {
    return await this.runner.run(["query", RUN_KEY, "/v", name]) === 0;
  }

  private async deleteValue(name: string): Promise<void> {
    const code = await this.runner.run(["delete", RUN_KEY, "/v", name, "/f"]);
    if (code !== 0 && await this.valueExists(name)) {
      throw new Error("Could not update Start with Windows");
    }
  }
}

class RegExeRunner implements RegistryRunner {
  async run(arguments_: readonly string[]): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      execFile("reg.exe", [...arguments_], { windowsHide: true }, (error) => {
        if (error === null) {
          resolve(0);
          return;
        }
        if (typeof error.code === "number") resolve(error.code);
        else reject(error);
      });
    });
  }
}
