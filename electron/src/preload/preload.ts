import { contextBridge, ipcRenderer } from "electron";

import type { SettingsApi, SettingsPatch } from "../shared/settings";

const api: SettingsApi = {
  load: async () => await ipcRenderer.invoke("settings:get") as Awaited<ReturnType<SettingsApi["load"]>>,
  update: async (patch: SettingsPatch) => (
    await ipcRenderer.invoke("settings:update", patch) as Awaited<ReturnType<SettingsApi["update"]>>
  ),
};

contextBridge.exposeInMainWorld("undertoneSettings", api);

declare global {
  interface Window {
    undertoneSettings: SettingsApi;
  }
}
