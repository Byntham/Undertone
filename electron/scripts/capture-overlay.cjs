const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const scaleArgument = process.argv.find((value) => value.startsWith("--scale="));
const scale = Number(scaleArgument?.slice("--scale=".length) ?? "1");
if (![1, 1.5, 2].includes(scale)) throw new Error("Scale must be 1, 1.5, or 2");
app.commandLine.appendSwitch("force-device-scale-factor", String(scale));

const outputDir = path.resolve(
  __dirname,
  `../test-output/overlay/${Math.round(scale * 100)}pct`,
);
app.setPath("userData", path.join(outputDir, "profile"));
const overlayFile = path.resolve(__dirname, "../dist/renderer/overlay/index.html");

function rgbChannels(color) {
  return color.match(/[\d.]+/gu)?.slice(0, 3).join(",") ?? color;
}

async function capture(win, state, text = "", tone = "normal", name = `${state}-${tone}`) {
  await win.webContents.executeJavaScript(`
    document.querySelector("#pill").className = "pill ${state} ${tone}";
    document.querySelector("#label").textContent = ${JSON.stringify(text)};
    document.querySelector("#check").textContent = ${JSON.stringify(tone === "error" ? "×" : tone === "warning" ? "!" : "")};
    for (const [index, bar] of [...document.querySelectorAll("#bars i")].entries()) {
      bar.style.height = ${JSON.stringify(state === "recording" ? "12px" : "")};
      if (${JSON.stringify(state === "recording")}) bar.style.height = [8, 13, 17, 11, 7][index] + "px";
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  win.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (tone === "success") {
    const renderedColor = await win.webContents.executeJavaScript(`(() => {
      const pill = document.querySelector("#pill");
      const bar = document.querySelector("#bars i");
      return {
        className: pill.className,
        variable: getComputedStyle(pill).getPropertyValue("--bar-color"),
        background: getComputedStyle(bar).backgroundColor,
      };
    })()`);
    if (renderedColor.variable.trim() !== "152 195 121"
        || !renderedColor.background.includes("152, 195, 121")) {
      throw new Error(`Paste confirmation did not resolve to green: ${JSON.stringify(renderedColor)}`);
    }
    await win.capturePage();
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const image = await win.capturePage();
  await writeFile(path.join(outputDir, `${name}.png`), image.toPNG());
}

async function captureFade(win, tone, direction) {
  const hidden = direction === "in" ? " hidden" : "";
  await win.webContents.executeJavaScript(`
    document.querySelector("#pill").className = "pill signal ${tone}${hidden}";
    for (const bar of document.querySelectorAll("#bars i")) bar.style.height = "";
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const before = await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector("#pill");
    const bounds = pill.getBoundingClientRect();
    const barsElement = document.querySelector("#bars");
    const barBounds = barsElement.getBoundingClientRect();
    const horizontalEdges = [barsElement, ...document.querySelectorAll("#bars i")]
      .flatMap((element) => {
        const edgeBounds = element.getBoundingClientRect();
        return [edgeBounds.left, edgeBounds.right];
      })
      .map((edge) => edge * devicePixelRatio);
    return {
      centerX: bounds.x + bounds.width / 2,
      centerY: bounds.y + bounds.height / 2,
      barCenterX: barBounds.x + barBounds.width / 2,
      barCenterY: barBounds.y + barBounds.height / 2,
      horizontalEdges,
      color: getComputedStyle(document.querySelector("#bars i")).backgroundColor,
    };
  })()`);
  await win.webContents.executeJavaScript(
    `document.querySelector("#pill").classList.${direction === "in" ? "remove" : "add"}("hidden")`,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  const after = await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector("#pill");
    const bounds = pill.getBoundingClientRect();
    const barsElement = document.querySelector("#bars");
    const barBounds = barsElement.getBoundingClientRect();
    const horizontalEdges = [barsElement, ...document.querySelectorAll("#bars i")]
      .flatMap((element) => {
        const edgeBounds = element.getBoundingClientRect();
        return [edgeBounds.left, edgeBounds.right];
      })
      .map((edge) => edge * devicePixelRatio);
    return {
      centerX: bounds.x + bounds.width / 2,
      centerY: bounds.y + bounds.height / 2,
      barCenterX: barBounds.x + barBounds.width / 2,
      barCenterY: barBounds.y + barBounds.height / 2,
      horizontalEdges,
      color: getComputedStyle(document.querySelector("#bars i")).backgroundColor,
    };
  })()`);
  if (before.centerX !== after.centerX || before.centerY !== after.centerY
      || before.barCenterX !== after.barCenterX || before.barCenterY !== after.barCenterY) {
    throw new Error(`Overlay moved during fade-${direction}`);
  }
  if (rgbChannels(before.color) !== rgbChannels(after.color)) {
    throw new Error(`Overlay changed hue during fade-${direction}`);
  }
  for (const edge of [...before.horizontalEdges, ...after.horizontalEdges]) {
    if (Math.abs(edge - Math.round(edge)) > 0.001) {
      throw new Error(`Overlay left the physical pixel grid during fade-${direction}`);
    }
  }
  if (before.horizontalEdges.some((edge, index) => edge !== after.horizontalEdges[index])) {
    throw new Error(`Overlay bar edges moved during fade-${direction}`);
  }
  const image = await win.capturePage();
  await writeFile(path.join(outputDir, `fade-${direction}-${tone}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  await mkdir(outputDir, { recursive: true });
  const win = new BrowserWindow({
    width: 420,
    height: 52,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(overlayFile);
  await capture(win, "recording");
  await capture(win, "locked");
  await capture(win, "transcribing");
  await capture(win, "slow");
  await capture(
    win,
    "signal",
    "Too short — hold the key while you speak",
    "warning",
    "too-short-warning",
  );
  await capture(win, "signal", "No speech detected", "error", "no-speech-error");
  await capture(win, "signal", "Text pasted", "success", "paste-success");
  await capture(
    win,
    "message",
    "Couldn't paste — the text is on your clipboard",
    "warning",
    "paste-fallback-warning",
  );
  await captureFade(win, "warning", "in");
  await captureFade(win, "error", "out");
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
