import { contextBridge, ipcRenderer } from "electron";
import type { OverlayState, TurnDraftView } from "../shared/overlay";

export type { OverlayState, TurnDraftView } from "../shared/overlay";

contextBridge.exposeInMainWorld("undertoneOverlay", {
  onState: (listener: (state: OverlayState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OverlayState): void => {
      listener(state);
    };
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
  onLevel: (listener: (level: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, level: number): void => {
      listener(level);
    };
    ipcRenderer.on("overlay:level", handler);
    return () => ipcRenderer.removeListener("overlay:level", handler);
  },
  onTurnDraft: (listener: (draft: TurnDraftView | null) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      draft: TurnDraftView | null,
    ): void => {
      listener(draft);
    };
    ipcRenderer.on("overlay:turnDraft", handler);
    return () => ipcRenderer.removeListener("overlay:turnDraft", handler);
  },
});
