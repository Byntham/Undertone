import type {
  AppUpdater,
  ProgressInfo,
  UpdateInfo,
} from "electron-updater";

import type { AppUpdateSnapshot } from "../shared/settings";

export interface AppUpdateServiceOptions {
  updater: AppUpdater | null;
  currentVersion: string;
  unavailableMessage: string;
  prepareToInstall: () => Promise<void>;
  onStatus: (snapshot: AppUpdateSnapshot) => void;
}

export class AppUpdateService {
  private readonly updater: AppUpdater | null;
  private readonly prepareToInstall: () => Promise<void>;
  private readonly onStatus: (snapshot: AppUpdateSnapshot) => void;
  private state: AppUpdateSnapshot;
  private checkPromise: Promise<AppUpdateSnapshot> | null = null;

  constructor(options: AppUpdateServiceOptions) {
    this.updater = options.updater;
    this.prepareToInstall = options.prepareToInstall;
    this.onStatus = options.onStatus;
    this.state = options.updater === null ? {
      supported: false,
      phase: "unavailable",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progress: null,
      message: options.unavailableMessage,
    } : {
      supported: true,
      phase: "idle",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progress: null,
      message: "Updates are checked securely through GitHub Releases.",
    };
    if (this.updater !== null) this.configureUpdater(this.updater);
  }

  snapshot(): AppUpdateSnapshot {
    return { ...this.state };
  }

  async check(): Promise<AppUpdateSnapshot> {
    if (this.updater === null || this.state.phase === "downloaded") return this.snapshot();
    if (this.checkPromise !== null) return await this.checkPromise;
    this.checkPromise = this.runCheck(this.updater).finally(() => {
      this.checkPromise = null;
    });
    return await this.checkPromise;
  }

  async install(): Promise<void> {
    if (this.updater === null || this.state.phase !== "downloaded") {
      throw new Error("An update has not finished downloading");
    }
    await this.prepareToInstall();
    this.updater.quitAndInstall(false, true);
  }

  private configureUpdater(updater: AppUpdater): void {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = console;
    updater.on("checking-for-update", () => {
      this.setState({
        phase: "checking",
        availableVersion: null,
        progress: null,
        message: "Checking for updates...",
      });
    });
    updater.on("update-available", (info: UpdateInfo) => {
      this.setState({
        phase: "downloading",
        availableVersion: info.version,
        progress: 0,
        message: `Downloading Undertone ${info.version}...`,
      });
    });
    updater.on("download-progress", (info: ProgressInfo) => {
      const progress = clampProgress(info.percent);
      this.setState({
        phase: "downloading",
        progress,
        message: `Downloading Undertone ${this.state.availableVersion ?? "update"} (${Math.round(progress)}%)...`,
      });
    });
    updater.on("update-downloaded", (info: UpdateInfo) => {
      this.setState({
        phase: "downloaded",
        availableVersion: info.version,
        progress: 100,
        message: `Undertone ${info.version} is ready to install.`,
      });
    });
    updater.on("update-not-available", () => {
      this.setState({
        phase: "up-to-date",
        availableVersion: null,
        progress: null,
        message: `Undertone ${this.state.currentVersion} is up to date.`,
      });
    });
    updater.on("error", (error: Error) => {
      this.setError(error);
    });
  }

  private async runCheck(updater: AppUpdater): Promise<AppUpdateSnapshot> {
    this.setState({
      phase: "checking",
      availableVersion: null,
      progress: null,
      message: "Checking for updates...",
    });
    try {
      const result = await updater.checkForUpdates();
      if (result === null && this.state.phase === "checking") {
        this.setError(new Error("The update service is unavailable"));
      } else if (result !== null
        && !result.isUpdateAvailable
        && this.state.phase === "checking") {
        this.setState({
          phase: "up-to-date",
          availableVersion: null,
          progress: null,
          message: `Undertone ${this.state.currentVersion} is up to date.`,
        });
      }
    } catch (error) {
      this.setError(error);
    }
    return this.snapshot();
  }

  private setError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.setState({
      phase: "error",
      progress: null,
      message: `Could not check for updates: ${detail}`,
    });
  }

  private setState(patch: Partial<AppUpdateSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.onStatus(this.snapshot());
  }
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}
