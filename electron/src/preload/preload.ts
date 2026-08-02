import { contextBridge, ipcRenderer } from "electron";

import type {
  LocalEngineAction,
  LocalEngineKind,
  SettingsApi,
  SettingsPatch,
} from "../shared/settings";

const api: SettingsApi = {
  load: async () => await ipcRenderer.invoke("settings:get") as Awaited<ReturnType<SettingsApi["load"]>>,
  update: async (patch: SettingsPatch) => (
    await ipcRenderer.invoke("settings:update", patch) as Awaited<ReturnType<SettingsApi["update"]>>
  ),
  localAction: async (kind: LocalEngineKind, action: LocalEngineAction) => (
    await ipcRenderer.invoke("local:action", { kind, action }) as Awaited<
      ReturnType<SettingsApi["localAction"]>
    >
  ),
};

contextBridge.exposeInMainWorld("undertoneSettings", api);

declare global {
  interface Window {
    undertoneSettings: SettingsApi;
  }
}
