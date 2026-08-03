import { contextBridge, ipcRenderer } from "electron";

export interface OverlayState {
  state: "recording" | "locked" | "transcribing" | "message" | "hidden";
  text: string;
  tone?: "normal" | "warning" | "error";
}

contextBridge.exposeInMainWorld("undertoneOverlay", {
  onState: (listener: (state: OverlayState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OverlayState): void => {
      listener(state);
    };
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
});
