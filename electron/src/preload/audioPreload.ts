import { contextBridge, ipcRenderer } from "electron";

export type AudioCommand =
  | { type: "start"; captureId: number; deviceName?: string; stream: boolean }
  | { type: "meter"; deviceName?: string; requestId: number }
  | { type: "stop"; requestId: number }
  | { type: "cancel" }
  | { type: "cue"; name: "start" | "stop" | "lock" | "cancel" };
export type AudioEvent =
  | { type: "ready"; devices: string[] }
  | { type: "devices"; devices: string[] }
  | { type: "level"; rms: number }
  | { type: "chunk"; captureId: number; samples: ArrayBuffer; sampleRate: number }
  | { type: "stopped"; requestId: number; wav?: ArrayBuffer; durationMs: number }
  | { type: "meter"; requestId: number; peak?: number; error?: string }
  | { type: "error"; requestId?: number; message: string };

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
