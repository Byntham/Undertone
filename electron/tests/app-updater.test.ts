import { EventEmitter } from "node:events";

import type { AppUpdater, UpdateCheckResult } from "electron-updater";
import { describe, expect, it } from "vitest";

import { AppUpdateService } from "../src/main/appUpdater";
import type { AppUpdateSnapshot } from "../src/shared/settings";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  logger: unknown = null;
  result: UpdateCheckResult | null = null;
  checkError: Error | null = null;
  quitArguments: [boolean | undefined, boolean | undefined] | null = null;

  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    this.emit("checking-for-update");
    if (this.checkError !== null) throw this.checkError;
    return this.result;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitArguments = [isSilent, isForceRunAfter];
  }
}

describe("AppUpdateService", () => {
  it("explains why preview and portable builds cannot self-update", async () => {
    const service = new AppUpdateService({
      updater: null,
      currentVersion: "1.6.0",
      unavailableMessage: "Install Undertone to enable updates.",
      prepareToInstall: async () => undefined,
      onStatus: () => undefined,
    });

    expect(await service.check()).toEqual({
      supported: false,
      phase: "unavailable",
      currentVersion: "1.6.0",
      availableVersion: null,
      progress: null,
      message: "Install Undertone to enable updates.",
    });
  });

  it("checks for an update and reports an up-to-date installation", async () => {
    const updater = new FakeUpdater();
    updater.result = {
      isUpdateAvailable: false,
      updateInfo: {
        version: "1.6.0",
        files: [],
        path: "",
        sha512: "",
        releaseDate: "2026-08-02T00:00:00.000Z",
      },
      versionInfo: {
        version: "1.6.0",
        files: [],
        path: "",
        sha512: "",
        releaseDate: "2026-08-02T00:00:00.000Z",
      },
    };
    const statuses: AppUpdateSnapshot[] = [];
    const service = createService(updater, statuses);

    expect((await service.check()).phase).toBe("up-to-date");
    expect(service.snapshot().message).toContain("1.6.0 is up to date");
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(statuses.some((status) => status.phase === "checking")).toBe(true);
  });

  it("tracks download progress and safely restarts into the installer", async () => {
    const updater = new FakeUpdater();
    const order: string[] = [];
    const service = new AppUpdateService({
      updater: updater as unknown as AppUpdater,
      currentVersion: "1.6.0",
      unavailableMessage: "",
      prepareToInstall: async () => { order.push("shutdown"); },
      onStatus: () => undefined,
    });

    updater.emit("update-available", { version: "1.7.0" });
    updater.emit("download-progress", { percent: 47.6 });
    expect(service.snapshot()).toMatchObject({
      phase: "downloading",
      availableVersion: "1.7.0",
      progress: 47.6,
    });
    updater.emit("update-downloaded", { version: "1.7.0" });
    expect(service.snapshot().phase).toBe("downloaded");

    await service.install();
    order.push("installer");
    expect(order).toEqual(["shutdown", "installer"]);
    expect(updater.quitArguments).toEqual([false, true]);
  });

  it("turns network failures into a retryable status", async () => {
    const updater = new FakeUpdater();
    updater.checkError = new Error("offline");
    const service = createService(updater, []);

    expect(await service.check()).toMatchObject({
      phase: "error",
      message: "Could not check for updates: offline",
    });
  });
});

function createService(
  updater: FakeUpdater,
  statuses: AppUpdateSnapshot[],
): AppUpdateService {
  return new AppUpdateService({
    updater: updater as unknown as AppUpdater,
    currentVersion: "1.6.0",
    unavailableMessage: "",
    prepareToInstall: async () => undefined,
    onStatus: (status) => statuses.push(status),
  });
}
