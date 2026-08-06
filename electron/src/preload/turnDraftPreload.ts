import { contextBridge, ipcRenderer } from "electron";
import type { TurnDraftView } from "../shared/overlay";

contextBridge.exposeInMainWorld("undertoneTurnDraft", {
  discard: (): void => { ipcRenderer.send("turnDraft:discard"); },
  snap: (): void => { ipcRenderer.send("turnDraft:snap"); },
  onView: (listener: (draft: TurnDraftView) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      draft: TurnDraftView,
    ): void => { listener(draft); };
    ipcRenderer.on("turnDraft:view", handler);
    return () => ipcRenderer.removeListener("turnDraft:view", handler);
  },
});
