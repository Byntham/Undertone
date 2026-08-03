import { contextBridge, ipcRenderer } from "electron";

import type {
  AppUpdateSnapshot,
  LocalEngineAction,
  LocalEngineKind,
  HistoryAction,
  ProviderTestKind,
  SettingsApi,
  SettingsPatch,
  ShortcutSetting,
  SystemAction,
} from "../shared/settings";

const api: SettingsApi = {
  load: async () => await ipcRenderer.invoke("settings:get") as Awaited<ReturnType<SettingsApi["load"]>>,
  update: async (patch: SettingsPatch) => (
    await ipcRenderer.invoke("settings:update", patch) as Awaited<ReturnType<SettingsApi["update"]>>
  ),
  captureShortcut: async (field: ShortcutSetting) => (
    await ipcRenderer.invoke("shortcut:capture", { field }) as Awaited<
      ReturnType<SettingsApi["captureShortcut"]>
    >
  ),
  localAction: async (kind: LocalEngineKind, action: LocalEngineAction) => (
    await ipcRenderer.invoke("local:action", { kind, action }) as Awaited<
      ReturnType<SettingsApi["localAction"]>
    >
  ),
  history: async () => await ipcRenderer.invoke("history:get") as Awaited<
    ReturnType<SettingsApi["history"]>
  >,
  historyAction: async (id: number, action: HistoryAction) => {
    await ipcRenderer.invoke("history:action", { id, action });
  },
  systemAction: async (action: SystemAction) => {
    await ipcRenderer.invoke("system:action", { action });
  },
  providerTest: async (kind: ProviderTestKind) => (
    await ipcRenderer.invoke("provider:test", { kind }) as string
  ),
  microphoneTest: async () => await ipcRenderer.invoke("microphone:test") as number,
  updateStatus: async () => await ipcRenderer.invoke("update:status") as AppUpdateSnapshot,
  checkForUpdates: async () => await ipcRenderer.invoke("update:check") as AppUpdateSnapshot,
  installUpdate: async () => {
    await ipcRenderer.invoke("update:install");
  },
  onUpdateStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: AppUpdateSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on("update:status", wrapped);
    return () => ipcRenderer.removeListener("update:status", wrapped);
  },
};

contextBridge.exposeInMainWorld("undertoneSettings", api);

declare global {
  interface Window {
    undertoneSettings: SettingsApi;
  }
}
