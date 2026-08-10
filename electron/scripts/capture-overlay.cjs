const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const scaleArgument = process.argv.find((value) => value.startsWith("--scale="));
const scale = Number(scaleArgument?.slice("--scale=".length) ?? "1");
if (![1, 1.5, 2].includes(scale)) throw new Error("Scale must be 1, 1.5, or 2");
app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
app.on("window-all-closed", () => {});

const outputDir = path.resolve(__dirname, `../test-output/overlay/${Math.round(scale * 100)}pct`);
app.setPath("userData", path.join(outputDir, `profile-${process.pid}`));
const overlayFile = path.resolve(__dirname, "../dist/renderer/overlay/index.html");
const turnDraftFile = path.resolve(__dirname, "../dist/renderer/turn-draft/index.html");
const turnDraftPreload = path.resolve(__dirname, "../dist/main/preload/turnDraftPreload.js");

async function capturePage(win) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await win.capturePage();
    } catch (error) {
      lastError = error;
      win.showInactive();
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function captureMessageOverlay() {
  const win = new BrowserWindow({
    width: 420,
    height: 52,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadFile(overlayFile);
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const [tone, text] of [
      ["normal", "Text pasted"],
      ["warning", "Couldn't paste — the text is on your clipboard"],
      ["error", "Audio service is not ready"],
    ]) {
      await win.webContents.executeJavaScript(`(() => {
        const pill = document.querySelector("#pill");
        pill.className = "pill message ${tone}";
        document.querySelector("#label").textContent = ${JSON.stringify(text)};
        document.querySelector("#check").textContent = ${JSON.stringify(tone === "error" ? "×" : tone === "warning" ? "!" : "")};
      })()`);
      const layout = await win.webContents.executeJavaScript(`(() => ({
        hasBars: document.querySelector("#bars") !== null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }))()`);
      if (layout.hasBars || layout.overflow) {
        throw new Error(`Message overlay retained obsolete bar UI: ${JSON.stringify(layout)}`);
      }
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const image = await capturePage(win);
      await writeFile(path.join(outputDir, `message-${tone}.png`), image.toPNG());
    }
  } finally {
    win.destroy();
  }
}

async function captureTurnDraft() {
  const shortText = "A clean turn grows.";
  const mediumText = [
    "Now, when the text wraps, the edges of the pill are significantly outside the edges of the text.",
    "We should fit the pill size to the width of the text so there aren't these big borders on the edges.",
  ].join(" ");
  const cappedText = Array.from(
    { length: 24 },
    (_, index) => `Sentence ${index + 1} keeps extending the open turn with readable transcript text.`,
  ).join(" ");
  let revision = 0;
  let requestedHeight = 68;
  let compactCapture = false;
  const completedDismissals = [];
  const win = new BrowserWindow({
    width: 320,
    height: 68,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: turnDraftPreload,
    },
  });
  const resizeFromRenderer = (event, height) => {
    if (event.sender !== win.webContents || !Number.isFinite(height) || compactCapture) return;
    requestedHeight = Math.round(height);
    const nextHeight = Math.max(68, Math.min(360, requestedHeight));
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x,
      y: bounds.y + bounds.height - nextHeight,
      width: bounds.width,
      height: nextHeight,
    });
  };
  const recordDismissal = (event, completedRevision) => {
    if (event.sender === win.webContents && Number.isInteger(completedRevision)) {
      completedDismissals.push(completedRevision);
    }
  };
  ipcMain.on("turnDraft:content-height", resizeFromRenderer);
  ipcMain.on("turnDraft:dismiss-complete", recordDismissal);
  try {
    await win.loadFile(turnDraftFile);
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const sendDraft = async (
      text,
      activity = "listening",
      presentation = "visible",
      viewRevision = ++revision,
      statusText = null,
    ) => {
      win.webContents.send("turnDraft:view", {
        text,
        fragmentCount: text.length === 0 ? 0 : 1,
        charCount: text.length,
        liveState: activity === "listening"
          ? "listening"
          : activity === "finalizing" ? "finalizing" : null,
        activity,
        statusText,
        presentation,
        revision: viewRevision,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    const waitForHeight = async (predicate) => {
      const deadline = Date.now() + 1_500;
      let stable = 0;
      let previous = -1;
      while (Date.now() < deadline) {
        const height = win.getBounds().height;
        stable = predicate(height) && height === previous ? stable + 1 : 0;
        if (stable >= 3) return height;
        previous = height;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Turn draft height did not settle: ${JSON.stringify({ bounds: win.getBounds(), requestedHeight })}`);
    };

    const inspect = async (expectedText) => await win.webContents.executeJavaScript(`(() => {
      const draft = document.querySelector("#draft");
      const text = document.querySelector("#draftText");
      const path = document.querySelector("#signalPath");
      const rim = document.querySelector("#signalRim");
      const draftRect = draft.getBoundingClientRect();
      const viewportRect = document.querySelector("#draftViewport").getBoundingClientRect();
      return {
        activity: draft.dataset.activity,
        presentation: draft.dataset.presentation,
        ariaLabel: draft.getAttribute("aria-label"),
        hasBars: document.querySelector("#bars") !== null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        continuousText: text.textContent === ${JSON.stringify(expectedText)},
        verticalOverflow: text.scrollHeight > text.clientHeight + 1,
        latestVisible: text.scrollHeight - text.scrollTop <= text.clientHeight + 1,
        rimOpacity: Number.parseFloat(getComputedStyle(rim).opacity),
        rimAnimation: getComputedStyle(path).animationName,
        dasharray: getComputedStyle(path).strokeDasharray,
        strokeOpacity: Number.parseFloat(getComputedStyle(path).strokeOpacity),
        strokeWidth: Number.parseFloat(getComputedStyle(path).strokeWidth),
        pathFilter: getComputedStyle(path).filter,
        voiceLevel: Number.parseFloat(
          getComputedStyle(draft).getPropertyValue("--voice-level"),
        ),
        listeningWake: draft.classList.contains("listeningWake"),
        leftInset: viewportRect.left - draftRect.left,
        rightInset: draftRect.right - viewportRect.right,
        opacity: Number.parseFloat(getComputedStyle(draft).opacity),
        shadow: getComputedStyle(draft).boxShadow,
      };
    })()`);

    const capture = async (name) => {
      await win.webContents.executeJavaScript(`document.querySelector("#draft").classList.remove("reveal")`);
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await capturePage(win);
      const image = await capturePage(win);
      await writeFile(path.join(outputDir, `${name}.png`), image.toPNG());
    };

    compactCapture = true;
    win.setBounds({ ...win.getBounds(), width: 72, height: 44 });
    await sendDraft("", "idle");
    await sendDraft("", "listening");
    const compactIgnition = await inspect("");
    if (!compactIgnition.listeningWake
        || compactIgnition.rimAnimation !== "auroraListeningWake"
        || compactIgnition.dasharray !== "none"
        || compactIgnition.strokeOpacity >= 1
        || compactIgnition.pathFilter === "none") {
      throw new Error(`Compact Aurora ignition is invalid: ${JSON.stringify(compactIgnition)}`);
    }
    await capture("compact-aurora-ignition");
    await new Promise((resolve) => setTimeout(resolve, 220));
    const compactListening = await inspect("");
    if (compactListening.listeningWake
        || compactListening.rimAnimation !== "auroraListeningBreath") {
      throw new Error(`Compact Aurora ignition did not settle: ${JSON.stringify(compactListening)}`);
    }
    compactCapture = false;
    win.setBounds({ ...win.getBounds(), width: 320, height: 68 });

    await sendDraft(shortText, "idle");
    await waitForHeight((height) => height === 68);
    await capture("open-turn-aurora-idle");

    await sendDraft(shortText, "listening");
    const ignition = await inspect(shortText);
    if (!ignition.listeningWake || ignition.rimAnimation !== "auroraListeningWake"
        || ignition.dasharray !== "none" || ignition.strokeOpacity >= 1
        || ignition.pathFilter === "none") {
      throw new Error(`Aurora ignition is invalid: ${JSON.stringify(ignition)}`);
    }
    await capture("open-turn-aurora-ignition");
    await new Promise((resolve) => setTimeout(resolve, 220));
    const resting = await inspect(shortText);
    for (const level of [0.018, 0.03, 0.055, 0.09]) {
      win.webContents.send("turnDraft:level", level);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const listening = await inspect(shortText);
    if (listening.hasBars || listening.rimAnimation !== "auroraListeningBreath"
        || resting.rimOpacity > 0.4
        || listening.voiceLevel < resting.voiceLevel + 0.35
        || listening.rimOpacity < resting.rimOpacity + 0.2
        || listening.strokeWidth < resting.strokeWidth + 0.5) {
      throw new Error(`Aurora listening state is invalid: ${JSON.stringify(listening)}`);
    }
    await capture("open-turn-aurora-listening");

    const stableBounds = win.getBounds();
    await sendDraft(shortText, "finalizing");
    const loading = await inspect(shortText);
    if (JSON.stringify(win.getBounds()) !== JSON.stringify(stableBounds)
        || loading.rimAnimation === "none" || loading.dasharray === "none") {
      throw new Error(`Aurora loading state is invalid: ${JSON.stringify(loading)}`);
    }
    await capture("open-turn-aurora-loading");

    await sendDraft(shortText, "error", "visible", ++revision, "No speech detected");
    const noSpeech = await inspect(shortText);
    if (noSpeech.ariaLabel !== "No speech detected" || noSpeech.dasharray !== "none"
        || noSpeech.rimOpacity < 0.9) {
      throw new Error(`Aurora failure state is invalid: ${JSON.stringify(noSpeech)}`);
    }
    await capture("open-turn-aurora-no-speech");

    const dismissRevision = ++revision;
    const beforeDismiss = win.getBounds();
    await sendDraft("", "error", "dismissing", dismissRevision, "No speech detected");
    await new Promise((resolve) => setTimeout(resolve, 190));
    const dismissal = await inspect("");
    if (JSON.stringify(win.getBounds()) !== JSON.stringify(beforeDismiss)
        || dismissal.opacity > 0.01) {
      throw new Error(`Aurora failure resized before fading: ${JSON.stringify({ beforeDismiss, after: win.getBounds(), dismissal })}`);
    }
    await capture("open-turn-aurora-error-dismissal");
    if (!completedDismissals.includes(dismissRevision)) {
      await win.webContents.executeJavaScript(`document.querySelector("#draft").dispatchEvent(
        new AnimationEvent("animationend", { animationName: "draftDismiss", bubbles: true })
      )`);
    }

    await sendDraft(mediumText, "idle");
    const expandedHeight = await waitForHeight((height) => height > 68 && height < 360);
    const expanded = await inspect(mediumText);
    if (expanded.overflow || expanded.verticalOverflow || !expanded.continuousText
        || Math.abs(expanded.leftInset - expanded.rightInset) > 0.5) {
      throw new Error(`Aurora growth is invalid: ${JSON.stringify(expanded)}`);
    }
    await capture("open-turn-aurora-expanded");

    await sendDraft(cappedText, "idle");
    await waitForHeight((height) => height === 360);
    const capped = await inspect(cappedText);
    if (expandedHeight >= 360 || !capped.verticalOverflow || !capped.latestVisible || capped.overflow) {
      throw new Error(`Aurora cap is invalid: ${JSON.stringify(capped)}`);
    }
    await capture("open-turn-aurora-capped");
  } finally {
    ipcMain.removeListener("turnDraft:content-height", resizeFromRenderer);
    ipcMain.removeListener("turnDraft:dismiss-complete", recordDismissal);
    win.destroy();
  }
}

app.whenReady().then(async () => {
  await mkdir(outputDir, { recursive: true });
  await captureMessageOverlay();
  await captureTurnDraft();
  app.quit();
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
