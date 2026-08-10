import { contextBridge, ipcRenderer } from "electron";
import type { OverlayState } from "../shared/overlay";

export type { OverlayState } from "../shared/overlay";

contextBridge.exposeInMainWorld("undertoneOverlay", {
  onState: (listener: (state: OverlayState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OverlayState): void => {
      listener(state);
    };
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
});
