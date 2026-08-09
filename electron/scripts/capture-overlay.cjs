const { app, BrowserWindow, ipcMain } = require("electron");
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
const turnDraftFile = path.resolve(__dirname, "../dist/renderer/turn-draft/index.html");
const turnDraftPreload = path.resolve(__dirname, "../dist/main/preload/turnDraftPreload.js");

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

async function captureTurnDraft() {
  const designs = [
    "smoked-glass",
    "quiet-slate",
    "center-rail",
    "aurora-film",
    "smoked-rim",
    "slate-pulse",
    "aurora-rim",
  ];
  const integratedDesigns = new Set(["smoked-rim", "slate-pulse", "aurora-rim"]);
  const shortText = "A clean open turn grows with the words.";
  const mediumText = [
    "This open turn starts small and expands upward as the transcript develops.",
    "Its controls stay quiet until they are needed, while every dictated word remains visible.",
    "The voice activity stays connected to the same surface instead of floating beside it.",
  ].join(" ");
  const cappedText = Array.from(
    { length: 24 },
    (_, index) => `Sentence ${index + 1} keeps extending the open turn with readable transcript text.`,
  ).join(" ");
  let requestedHeight = 68;
  const requestedHeights = [];
  const win = new BrowserWindow({
    width: 400,
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
    if (event.sender !== win.webContents || !Number.isFinite(height)) return;
    requestedHeight = Math.round(height);
    requestedHeights.push(requestedHeight);
    const nextHeight = requestedHeight <= 44
      ? 44
      : Math.max(68, Math.min(360, requestedHeight));
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x,
      y: bounds.y + bounds.height - nextHeight,
      width: bounds.width,
      height: nextHeight,
    });
  };
  ipcMain.on("turnDraft:content-height", resizeFromRenderer);
  await win.loadFile(turnDraftFile);

  const setBaseBounds = (width, height) => {
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x + Math.round((bounds.width - width) / 2),
      y: bounds.y + bounds.height - height,
      width,
      height,
    });
  };

  const waitForStableRender = async (design, text, expectedHeight) => {
    const deadline = Date.now() + 1_500;
    let stablePasses = 0;
    let previousHeight = -1;
    while (Date.now() < deadline) {
      const rendered = await win.webContents.executeJavaScript(`(() => {
        const draft = document.querySelector("#draft");
        return {
          text: document.querySelector("#draftText").textContent,
          design: draft.dataset.design,
        };
      })()`);
      const height = win.getBounds().height;
      const expected = typeof expectedHeight === "function"
        ? expectedHeight(height)
        : height === expectedHeight;
      stablePasses = rendered.text === text && rendered.design === design
        && expected && height === previousHeight ? stablePasses + 1 : 0;
      if (stablePasses >= 3) return;
      previousHeight = height;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Open-turn ${design} did not settle: bounds=${JSON.stringify(win.getBounds())} requested=${requestedHeight}`,
    );
  };

  const sendDraft = async (design, text, activity = "recording") => {
    requestedHeights.length = 0;
    win.webContents.send("turnDraft:view", {
      text,
      fragmentCount: text.length === 0 ? 0 : 1,
      charCount: text.length,
      liveState: activity === "listening" ? "listening" : null,
      activity,
      design,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const level of [0.015, 0.04, 0.12, 0.28, 0.16]) {
      win.webContents.send("turnDraft:level", level);
    }
  };

  const inspectLayout = async (text) => win.webContents.executeJavaScript(`(() => {
    const draft = document.querySelector("#draft");
    const header = document.querySelector(".draftHeader");
    const text = document.querySelector("#draftText");
    const snap = document.querySelector("#snap");
    const discard = document.querySelector("#discard");
    const signalRim = document.querySelector("#signalRim");
    return {
      design: draft.dataset.design,
      integrated: draft.dataset.integrated,
      empty: draft.dataset.empty,
      activity: draft.dataset.activity,
      voiceLevel: Number.parseFloat(getComputedStyle(draft).getPropertyValue("--voice-level")) || 0,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      continuousText: text.textContent === ${JSON.stringify(text)},
      hasFragmentRows: document.querySelector("#draftList, .index, #draftText li") !== null,
      hasVerticalOverflow: text.scrollHeight > text.clientHeight + 1,
      textScrollHeight: text.scrollHeight,
      textClientHeight: text.clientHeight,
      viewportClientHeight: document.querySelector("#draftViewport").clientHeight,
      windowInnerHeight: window.innerHeight,
      latestVisible: text.scrollHeight - text.scrollTop <= text.clientHeight + 1,
      signalRimVisible: getComputedStyle(signalRim).display !== "none",
      shadow: getComputedStyle(draft).boxShadow,
      headerRegion: getComputedStyle(header).getPropertyValue("app-region")
        || getComputedStyle(header).getPropertyValue("-webkit-app-region"),
      snapRegion: getComputedStyle(snap).getPropertyValue("app-region")
        || getComputedStyle(snap).getPropertyValue("-webkit-app-region"),
      discardRegion: getComputedStyle(discard).getPropertyValue("app-region")
        || getComputedStyle(discard).getPropertyValue("-webkit-app-region"),
    };
  })()`);

  const captureDraft = async (name) => {
    // Hidden BrowserWindows can pause compositor animations. Capture the stable
    // resting state directly after verifying the renderer received the view.
    await win.webContents.executeJavaScript(
      `document.querySelector("#draft").classList.remove("reveal")`,
    );
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Prime Chromium's transparent compositor after native bounds changes.
    await win.capturePage();
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const image = await win.capturePage();
    await writeFile(path.join(outputDir, `${name}.png`), image.toPNG());
    return image;
  };

  try {
    for (const design of designs) {
      const integrated = integratedDesigns.has(design);
      if (integrated) {
        setBaseBounds(72, 44);
        await sendDraft(design, "");
        await waitForStableRender(design, "", 44);
        const compact = await inspectLayout("");
        if (!compact.signalRimVisible || compact.integrated !== "true"
            || compact.empty !== "true" || compact.activity !== "recording"
            || compact.voiceLevel <= 0 || compact.overflow) {
          throw new Error(`Open-turn ${design} compact layout is invalid: ${JSON.stringify(compact)}`);
        }
        await captureDraft(`open-turn-${design}-voice`);
        await sendDraft(design, "", "transcribing");
        await waitForStableRender(design, "", 44);
        await captureDraft(`open-turn-${design}-loading`);
        setBaseBounds(400, 68);
      } else {
        setBaseBounds(400, 68);
      }

      await sendDraft(design, shortText);
      await waitForStableRender(design, shortText, 68);
      const short = await inspectLayout(shortText);
      if (short.overflow || short.hasVerticalOverflow || !short.continuousText
          || short.hasFragmentRows || short.shadow !== "none") {
        throw new Error(`Open-turn ${design} short layout is invalid: ${JSON.stringify(short)}`);
      }
      await captureDraft(`open-turn-${design}-short`);

      await sendDraft(design, mediumText);
      await waitForStableRender(
        design,
        mediumText,
        (height) => height > 68 && height < 360,
      );
      const expandedHeight = win.getBounds().height;
      const medium = await inspectLayout(mediumText);
      if (medium.overflow || medium.hasVerticalOverflow || !medium.latestVisible
          || requestedHeights.length === 0) {
        throw new Error(`Open-turn ${design} growth is invalid: ${JSON.stringify({ medium, requestedHeights })}`);
      }
      const expandedImage = await captureDraft(`open-turn-${design}-expanded`);
      await writeFile(
        path.join(outputDir, `open-turn-${design}.png`),
        expandedImage.toPNG(),
      );
      if (design === "smoked-glass") {
        await writeFile(path.join(outputDir, "open-turn.png"), expandedImage.toPNG());
      }

      await sendDraft(design, cappedText);
      await waitForStableRender(design, cappedText, 360);
      const capped = await inspectLayout(cappedText);
      if (win.getBounds().height !== 360 || expandedHeight >= 360
          || !capped.hasVerticalOverflow || !capped.latestVisible || capped.overflow) {
        throw new Error(`Open-turn ${design} cap is invalid: ${JSON.stringify({ capped, expandedHeight })}`);
      }
      await captureDraft(`open-turn-${design}-capped`);
    }

    const layout = await inspectLayout(cappedText);
    if (layout.headerRegion.trim() !== "drag"
        || layout.snapRegion.trim() !== "no-drag"
        || layout.discardRegion.trim() !== "no-drag") {
      throw new Error(`Open-turn interaction regions are invalid: ${JSON.stringify(layout)}`);
    }
    const snapped = new Promise((resolve) => ipcMain.once("turnDraft:snap", resolve));
    await win.webContents.executeJavaScript(`document.querySelector("#snap").click()`);
    await Promise.race([
      snapped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Snap IPC timed out")), 500)),
    ]);
    const discarded = new Promise((resolve) => ipcMain.once("turnDraft:discard", resolve));
    await win.webContents.executeJavaScript(`document.querySelector("#discard").click()`);
    await Promise.race([
      discarded,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Discard IPC timed out")), 500)),
    ]);
  } finally {
    ipcMain.removeListener("turnDraft:content-height", resizeFromRenderer);
    win.destroy();
  }
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
  await captureTurnDraft();
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
