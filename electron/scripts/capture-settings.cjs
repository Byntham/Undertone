const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const scaleIndex = process.argv.indexOf("--scale");
const scale = scaleIndex >= 0 ? Number(process.argv[scaleIndex + 1]) : 1;
if (![1, 1.5, 2].includes(scale)) throw new Error("Scale must be 1, 1.5, or 2");
app.commandLine.appendSwitch("force-device-scale-factor", String(scale));

const root = path.resolve(__dirname, "../dist/renderer");
const output = path.resolve(__dirname, `../../spikes/out/electron-settings-${scale}`);
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
    width: 960,
    height: 720,
    useContentSize: true,
    show: false,
    backgroundColor: "#282c34",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/`);
  await mkdir(output, { recursive: true });
  const sections = ["General", "Dictionary", "History", "Providers", "About"];
  const results = [];
  for (const [index, section] of sections.entries()) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('nav button')[${index}]?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const metrics = await win.webContents.executeJavaScript(`({
      devicePixelRatio,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: innerWidth,
      contentWidth: document.querySelector('main')?.scrollWidth ?? 0,
      title: document.querySelector('h1')?.textContent ?? ''
    })`);
    const image = await win.webContents.capturePage();
    await writeFile(path.join(output, `${section.toLowerCase()}.png`), image.toPNG());
    results.push({ section, ...metrics });
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
  console.log(JSON.stringify({ scale, results }));
  win.destroy();
  server.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  server.close();
  app.exit(1);
});
