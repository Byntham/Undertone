import { contextBridge, ipcRenderer } from "electron";
import type { TurnDraftBridge, TurnDraftView } from "../shared/overlay";

const turnDraftBridge: TurnDraftBridge = {
  discard: (): void => { ipcRenderer.send("turnDraft:discard"); },
  snap: (): void => { ipcRenderer.send("turnDraft:snap"); },
  reportContentHeight: (height: number): void => {
    ipcRenderer.send("turnDraft:content-height", height);
  },
  completeDismiss: (revision: number): void => {
    ipcRenderer.send("turnDraft:dismiss-complete", revision);
  },
  onView: (listener: (draft: TurnDraftView) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      draft: TurnDraftView,
    ): void => { listener(draft); };
    ipcRenderer.on("turnDraft:view", handler);
    return () => ipcRenderer.removeListener("turnDraft:view", handler);
  },
  onLevel: (listener: (level: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, level: number): void => {
      listener(level);
    };
    ipcRenderer.on("turnDraft:level", handler);
    return () => ipcRenderer.removeListener("turnDraft:level", handler);
  },
};

contextBridge.exposeInMainWorld("undertoneTurnDraft", turnDraftBridge);
