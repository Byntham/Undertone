const {
  app,
  BrowserWindow,
  nativeImage,
  screen,
} = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { mkdir, readFile, readdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const captureMode = process.argv.includes("--primed") ? "primed" : "fade";
const assertStable = process.argv.includes("--assert-stable");
const outputDir = path.resolve(__dirname, `../test-output/overlay-motion/bitblt/${captureMode}`);
const framesDir = path.join(outputDir, `frames-${process.pid}`);
const helperSource = path.resolve(__dirname, "OverlayMotionCapture.cs");
const helperExe = path.join(outputDir, "OverlayMotionCapture.exe");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const overlayFile = path.resolve(__dirname, "../dist/renderer/overlay/index.html");
const overlayPreload = path.resolve(__dirname, "../dist/main/preload/overlayPreload.js");
const windowWidth = 420;
const windowHeight = 52;
const margin = 12;
app.setPath("userData", path.join(outputDir, "profile"));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function analyzeFrame(bytes, scale) {
  const image = nativeImage.createFromBuffer(bytes);
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const region = {
    left: Math.floor(size.width / 2 - 40 * scale),
    right: Math.ceil(size.width / 2 + 40 * scale),
    top: Math.floor(size.height / 2 - 18 * scale),
    bottom: Math.ceil(size.height / 2 + 18 * scale),
  };
  let weight = 0;
  let weightedX = 0;
  let left = null;
  let right = null;
  let top = null;
  let bottom = null;
  for (let y = region.top; y < region.bottom; y += 1) {
    for (let x = region.left; x < region.right; x += 1) {
      const offset = (y * size.width + x) * 4;
      const brightness = Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
      if (brightness < 3) continue;
      left = left === null ? x : Math.min(left, x);
      right = right === null ? x : Math.max(right, x);
      top = top === null ? y : Math.min(top, y);
      bottom = bottom === null ? y : Math.max(bottom, y);
      const pixelWeight = brightness - 2;
      weight += pixelWeight;
      weightedX += x * pixelWeight;
    }
  }
  return {
    weight,
    centerX: weight === 0 ? null : Math.round((weightedX / weight) * 1_000) / 1_000,
    boundsCenterX: left === null || right === null ? null : (left + right) / 2,
    boundsHeight: top === null || bottom === null ? null : bottom - top + 1,
  };
}

function rangeOf(values) {
  return values.length === 0 ? null : Math.max(...values) - Math.min(...values);
}

app.whenReady().then(async () => {
  await mkdir(framesDir, { recursive: true });
  const compile = spawnSync(compiler, [
    "/nologo",
    "/target:exe",
    "/platform:x64",
    "/optimize+",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Drawing.dll",
    `/out:${helperExe}`,
    helperSource,
  ], { encoding: "utf8" });
  if (compile.status !== 0) throw new Error(compile.stderr || compile.stdout || "Capture helper failed to compile");

  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  const x = display.workArea.x + Math.round((display.workArea.width - windowWidth) / 2);
  const y = display.workArea.y + display.workArea.height - windowHeight - 24;
  const crop = {
    x: Math.round((x - margin) * scale),
    y: Math.round((y - margin) * scale),
    width: Math.round((windowWidth + margin * 2) * scale),
    height: Math.round((windowHeight + margin * 2) * scale),
  };

  const background = new BrowserWindow({
    x: x - margin,
    y: y - margin,
    width: windowWidth + margin * 2,
    height: windowHeight + margin * 2,
    show: false,
    frame: false,
    focusable: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#000000",
  });
  await background.loadURL("data:text/html,<body style='margin:0;background:%23000'></body>");
  background.showInactive();

  const overlay = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: overlayPreload,
    },
  });
  overlay.setIgnoreMouseEvents(true);
  await overlay.loadFile(overlayFile);
  overlay.webContents.send("overlay:state", { state: "hidden", text: "", tone: "normal" });

  if (captureMode === "primed") {
    overlay.setPosition(x, y, false);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.showInactive();
    overlay.moveTop();
    await delay(300);
    // Exercise a normal completed cycle so the entrance is measured from the
    // same hidden state used by subsequent dictations, not only app startup.
    overlay.webContents.send("overlay:state", { state: "transcribing", text: "", tone: "normal" });
    await delay(150);
    overlay.webContents.send("overlay:state", { state: "hidden", text: "", tone: "normal" });
    await delay(200);
  }

  const capture = spawn(helperExe, [
    String(crop.x),
    String(crop.y),
    String(crop.width),
    String(crop.height),
    "700",
    "16",
    framesDir,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    let output = "";
    capture.once("error", reject);
    capture.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY")) resolve();
    });
  });

  await delay(100);
  if (captureMode !== "primed") {
    overlay.setPosition(x, y, false);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.showInactive();
    overlay.moveTop();
    await delay(50);
  }
  overlay.webContents.send("overlay:state", { state: "recording", text: "", tone: "normal" });
  await delay(300);
  overlay.webContents.send("overlay:state", { state: "hidden", text: "", tone: "normal" });
  await new Promise((resolve, reject) => {
    capture.once("error", reject);
    capture.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Capture helper exited ${code}`)));
  });

  const timestampLines = (await readFile(path.join(framesDir, "timestamps.csv"), "utf8"))
    .trim().split(/\r?\n/u);
  const files = (await readdir(framesDir)).filter((name) => name.endsWith(".png")).sort();
  const analysis = [];
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(path.join(framesDir, file));
    const timeMs = Number(timestampLines[index]?.split(",")[1] ?? 0);
    analysis.push({ frame: index, timeMs, ...analyzeFrame(bytes, scale) });
  }
  await writeFile(
    path.join(outputDir, "analysis.json"),
    JSON.stringify({ captureMode, scale, crop, framesDir, frames: analysis }, null, 2),
    "utf8",
  );
  const visible = analysis.filter(({ weight }) => weight > 100);
  const firstVisibleTime = visible[0]?.timeMs ?? 0;
  const entrance = visible.filter(({ timeMs }) => timeMs <= firstVisibleTime + 200);
  const entranceCenterRange = rangeOf(
    entrance.map(({ centerX }) => centerX).filter((value) => value !== null),
  );
  const entranceBoundsRange = rangeOf(
    entrance.map(({ boundsCenterX }) => boundsCenterX).filter((value) => value !== null),
  );
  const entranceHeightRange = rangeOf(
    entrance.map(({ boundsHeight }) => boundsHeight).filter((value) => value !== null),
  );
  const stable = entranceCenterRange !== null && entranceCenterRange <= 0.1
    && entranceBoundsRange === 0 && entranceHeightRange === 0;
  console.log(
    `OVERLAY_BITBLT_CAPTURE_OK mode=${captureMode} frames=${analysis.length} visible=${visible.length}`
      + ` entranceCenterRangePx=${entranceCenterRange} entranceBoundsRangePx=${entranceBoundsRange}`
      + ` entranceHeightRangePx=${entranceHeightRange}`
      + ` stable=${stable}`,
  );

  overlay.destroy();
  background.destroy();
  if (assertStable && !stable) throw new Error("Overlay entrance moved in the raw frame capture");
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
