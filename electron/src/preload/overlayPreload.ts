import { contextBridge, ipcRenderer } from "electron";
import type { OverlayBridge, OverlayState } from "../shared/overlay";

const overlayBridge: OverlayBridge = {
  onState: (listener: (state: OverlayState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OverlayState): void => {
      listener(state);
    };
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
};

contextBridge.exposeInMainWorld("undertoneOverlay", overlayBridge);
