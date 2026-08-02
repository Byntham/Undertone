const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const outputDir = path.resolve(__dirname, "../../spikes/out/electron-overlay");
const overlayFile = path.resolve(__dirname, "../dist/renderer/overlay/index.html");

async function capture(win, state, text = "") {
  await win.webContents.executeJavaScript(`
    document.querySelector("#pill").className = "pill ${state}";
    document.querySelector("#label").textContent = ${JSON.stringify(text)};
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const image = await win.capturePage();
  await writeFile(path.join(outputDir, `${state}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  await mkdir(outputDir, { recursive: true });
  const win = new BrowserWindow({
    width: 220,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(overlayFile);
  await capture(win, "recording");
  await capture(win, "locked");
  await capture(win, "message", "Input path verified");
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
