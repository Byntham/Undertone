const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");

const audioFile = path.resolve(__dirname, "../dist/renderer/audio/index.html");
const preload = path.resolve(__dirname, "../dist/main/preload/audioPreload.js");
let audioWindow;
let finished = false;

function fail(message) {
  if (finished) return;
  finished = true;
  console.error(message);
  app.exit(1);
}

function succeed(byteLength, durationMs) {
  if (finished) return;
  finished = true;
  console.log(`AUDIO_SMOKE_OK bytes=${byteLength} durationMs=${durationMs}`);
  app.exit(0);
}

ipcMain.on("audio:event", (_event, payload) => {
  if (payload.type === "ready") {
    audioWindow.webContents.send("audio:command", { type: "start" });
  } else if (payload.type === "started") {
    setTimeout(() => {
      audioWindow.webContents.send("audio:command", { type: "stop" });
    }, 500);
  } else if (payload.type === "error") {
    fail(`Audio smoke error: ${payload.message}`);
  } else if (payload.type === "stopped") {
    const bytes = payload.wav instanceof ArrayBuffer
      ? new Uint8Array(payload.wav)
      : new Uint8Array(payload.wav.buffer, payload.wav.byteOffset, payload.wav.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (offset, length) => new TextDecoder().decode(
      bytes.subarray(offset, offset + length),
    );
    if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") {
      fail("Audio smoke returned an invalid WAV container");
    } else if (view.getUint16(22, true) !== 1
        || view.getUint32(24, true) !== 16_000
        || view.getUint16(34, true) !== 16
        || bytes.byteLength <= 44) {
      fail("Audio smoke returned the wrong PCM format");
    } else {
      succeed(bytes.byteLength, payload.durationMs);
    }
  }
});

app.whenReady().then(async () => {
  audioWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload,
    },
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === "media" && webContents === audioWindow.webContents;
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media" && webContents === audioWindow.webContents);
  });
  setTimeout(() => fail("Audio smoke timed out"), 10_000);
  await audioWindow.loadFile(audioFile);
}).catch((error) => fail(error instanceof Error ? error.message : String(error)));
