import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("undertone", {
  platform: process.platform,
});
