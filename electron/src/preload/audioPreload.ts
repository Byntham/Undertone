import { contextBridge, ipcRenderer } from "electron";

export type AudioCommand =
  | { type: "start"; deviceName?: string }
  | { type: "meter"; deviceName?: string; requestId: number }
  | { type: "stop" | "cancel" }
  | { type: "cue"; name: "start" | "stop" | "lock" | "cancel" };
export type AudioEvent =
  | { type: "ready"; devices: string[] }
  | { type: "devices"; devices: string[] }
  | { type: "level"; rms: number }
  | { type: "stopped"; wav: ArrayBuffer; durationMs: number }
  | { type: "meter"; requestId: number; peak?: number; error?: string }
  | { type: "error"; message: string };

contextBridge.exposeInMainWorld("undertoneAudio", {
  onCommand: (listener: (command: AudioCommand) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AudioCommand): void => {
      listener(command);
    };
    ipcRenderer.on("audio:command", handler);
    return () => ipcRenderer.removeListener("audio:command", handler);
  },
  emit: (event: AudioEvent): void => ipcRenderer.send("audio:event", event),
});
