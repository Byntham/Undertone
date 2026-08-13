const { app, BrowserWindow } = require("electron");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { version } = require("../package.json");

const scaleIndex = process.argv.indexOf("--scale");
const scale = scaleIndex >= 0 ? Number(process.argv[scaleIndex + 1]) : 1;
if (![1, 1.5, 2].includes(scale)) throw new Error("Scale must be 1, 1.5, or 2");
const widthIndex = process.argv.indexOf("--width");
const width = widthIndex >= 0 ? Number(process.argv[widthIndex + 1]) : 960;
const heightIndex = process.argv.indexOf("--height");
const height = heightIndex >= 0 ? Number(process.argv[heightIndex + 1]) : 720;
if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
  throw new Error("Width and height must be positive integers");
}
app.commandLine.appendSwitch("force-device-scale-factor", String(scale));

const root = path.resolve(__dirname, "../dist/renderer");
const sizeSuffix = width === 960 && height === 720 ? "" : `-${width}x${height}`;
const output = path.resolve(__dirname, `../test-output/settings-${scale}${sizeSuffix}`);
const profile = process.env.UNDERTONE_CAPTURE_PROFILE;
if (profile === undefined) throw new Error("Run captures through scripts/run-electron.mjs");
app.setPath("userData", profile);

const pause = async () => await new Promise((resolve) => setTimeout(resolve, 100));

async function selectSection(win, label) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const label = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll('nav button')]
      .find((candidate) => candidate.textContent?.includes(label));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Missing settings navigation button: ${label}`);

  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const title = await win.webContents.executeJavaScript(
      "document.querySelector('h1')?.textContent?.trim() ?? ''",
    );
    if (title === label) return;
    await pause();
  }
  throw new Error(`Settings section did not render its expected title: ${label}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    backgroundColor: "#282c34",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "settings-capture-preload.cjs"),
      additionalArguments: [`--undertone-capture-version=${version}`],
    },
  });
  await win.loadFile(path.join(root, "index.html"));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const sections = [
    { label: "General", filename: "general" },
    { label: "Speech & AI", filename: "speech-ai" },
    { label: "Dictionary", filename: "dictionary" },
    { label: "History", filename: "history" },
  ];
  const results = [];
  for (const section of sections) {
    await selectSection(win, section.label);
    await pause();
    const metrics = await win.webContents.executeJavaScript(`({
      devicePixelRatio,
      bodyWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      viewportWidth: innerWidth,
      hasHorizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth,
      contentWidth: document.querySelector('main')?.scrollWidth ?? 0,
      contentClientWidth: document.querySelector('main')?.clientWidth ?? 0,
      contentScrollTop: document.querySelector('main')?.scrollTop ?? 0,
      contentPaddingLeft: getComputedStyle(document.querySelector('main')).paddingLeft,
      sectionLeft: document.querySelector('main section')?.getBoundingClientRect().left ?? 0,
      sectionWidth: document.querySelector('main section')?.getBoundingClientRect().width ?? 0,
      hasContentHorizontalOverflow: (document.querySelector('main')?.scrollWidth ?? 0)
        > (document.querySelector('main')?.clientWidth ?? 0),
      clippedControls: [...document.querySelectorAll(
        '.card select, .card button, .localEngineCard select, .localEngineCard button'
      )].flatMap((control) => {
        const card = control.closest('.card, .localEngineCard');
        if (!card) return [];
        const controlBounds = control.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        if (controlBounds.left >= cardBounds.left && controlBounds.right <= cardBounds.right) {
          return [];
        }
        return [control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName];
      }),
      title: document.querySelector('h1')?.textContent ?? ''
    })`);
    if (metrics.title.trim() !== section.label) {
      throw new Error(`Captured ${metrics.title || "no title"} instead of ${section.label}`);
    }
    if (metrics.hasHorizontalOverflow || metrics.hasContentHorizontalOverflow) {
      throw new Error(`${section.label} has horizontal overflow at ${scale * 100}% scaling`);
    }
    if (metrics.clippedControls.length > 0) {
      throw new Error(`${section.label} clips controls at ${scale * 100}% scaling: ${
        metrics.clippedControls.join(', ')
      }`);
    }
    const image = await win.webContents.capturePage();
    await writeFile(path.join(output, `${section.filename}.png`), image.toPNG());
    results.push({ section: section.label, ...metrics });
  }
  await selectSection(win, "General");
  await win.webContents.executeJavaScript(`{
    const scrolling = document.scrollingElement;
    if (scrolling) scrolling.scrollTop = scrolling.scrollHeight;
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  }`);
  await pause();
  const generalBottom = await win.webContents.capturePage();
  await writeFile(path.join(output, "general-bottom.png"), generalBottom.toPNG());
  await selectSection(win, "Speech & AI");
  await win.webContents.executeJavaScript(`{
    const otherCredentials = document.querySelector('details.otherCredentials');
    if (otherCredentials) {
      otherCredentials.open = true;
      otherCredentials.scrollIntoView({ block: 'center' });
    }
  }`);
  await pause();
  const otherCredentials = await win.webContents.capturePage();
  await writeFile(path.join(output, "speech-ai-other-credentials.png"), otherCredentials.toPNG());
  await win.webContents.executeJavaScript(`{
    const otherCredentials = document.querySelector('details.otherCredentials');
    if (otherCredentials) otherCredentials.open = false;
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  }`);
  await pause();
  const speechAiOnDevice = await win.webContents.capturePage();
  await writeFile(path.join(output, "speech-ai-on-device.png"), speechAiOnDevice.toPNG());
  console.log(JSON.stringify({ scale, results }));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
