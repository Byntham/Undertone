const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

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
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== path.join(root, "index.html")) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(candidate);
    response.writeHead(200, { "Content-Type": contentTypes.get(path.extname(candidate)) ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Preview server did not bind");
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    backgroundColor: "#282c34",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/`);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const sections = [
    { label: "General", filename: "general" },
    { label: "Speech & AI", filename: "speech-ai" },
    { label: "Dictionary", filename: "dictionary" },
    { label: "History", filename: "history" },
  ];
  const results = [];
  for (const [index, section] of sections.entries()) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('nav button')[${index}]?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
      title: document.querySelector('h1')?.textContent ?? ''
    })`);
    const image = await win.webContents.capturePage();
    await writeFile(path.join(output, `${section.filename}.png`), image.toPNG());
    results.push({ section: section.label, ...metrics });
  }
  await win.webContents.executeJavaScript("document.querySelectorAll('nav button')[0]?.click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`{
    const scrolling = document.scrollingElement;
    if (scrolling) scrolling.scrollTop = scrolling.scrollHeight;
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  }`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const generalBottom = await win.webContents.capturePage();
  await writeFile(path.join(output, "general-bottom.png"), generalBottom.toPNG());
  await win.webContents.executeJavaScript("document.querySelectorAll('nav button')[1]?.click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`{
    const otherCredentials = document.querySelector('details.otherCredentials');
    if (otherCredentials) {
      otherCredentials.open = true;
      otherCredentials.scrollIntoView({ block: 'center' });
    }
  }`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const otherCredentials = await win.webContents.capturePage();
  await writeFile(path.join(output, "speech-ai-other-credentials.png"), otherCredentials.toPNG());
  await win.webContents.executeJavaScript(`{
    const otherCredentials = document.querySelector('details.otherCredentials');
    if (otherCredentials) otherCredentials.open = false;
    const advanced = document.querySelector('details.advancedSection');
    if (advanced) advanced.open = true;
    const modelSelection = advanced?.querySelector('.advancedGroup');
    if (modelSelection) modelSelection.scrollIntoView({ block: 'start' });
  }`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const speechAiModelSelection = await win.webContents.capturePage();
  await writeFile(path.join(output, "speech-ai-model-selection.png"), speechAiModelSelection.toPNG());
  await win.webContents.executeJavaScript(`{
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  }`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const speechAiAdvanced = await win.webContents.capturePage();
  await writeFile(path.join(output, "speech-ai-advanced.png"), speechAiAdvanced.toPNG());
  console.log(JSON.stringify({ scale, results }));
  win.destroy();
  server.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  server.close();
  app.exit(1);
});
