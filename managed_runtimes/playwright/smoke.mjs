import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const runtime = path.resolve(process.argv[2]);
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtime, "browsers");
process.env.HOME = path.join(runtime, ".smoke-home");
process.env.XDG_CACHE_HOME = path.join(runtime, ".smoke-cache");
if (process.platform === "linux") {
  process.env.LD_LIBRARY_PATH = path.join(runtime, "libraries");
  process.env.FONTCONFIG_PATH = path.join(runtime, "fontconfig");
}

const { chromium } = await import(
  pathToFileURL(
    path.join(runtime, "node_modules", "playwright-core", "index.mjs"),
  ).href
);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html><body><main><h1>Cantrip browser ready</h1><button>Inspect</button></main></body></html>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("smoke server failed");

let browserServer;
try {
  browserServer = await chromium.launchServer({
    headless: true,
    chromiumSandbox: true,
  });
  if (
    browserServer.process().spawnargs.some((value) => value === "--no-sandbox")
  )
    throw new Error("managed Chromium unexpectedly disabled its sandbox");
  const browser = await chromium.connect(browserServer.wsEndpoint());
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "domcontentloaded",
  });
  const snapshot = await firstPage.locator("body").ariaSnapshot();
  if (
    !snapshot.includes("Cantrip browser ready") ||
    !snapshot.includes("Inspect")
  )
    throw new Error("accessibility snapshot smoke failed");
  await first.addCookies([
    {
      name: "cantrip-isolation",
      value: "private",
      url: `http://127.0.0.1:${address.port}/`,
    },
  ]);
  const second = await browser.newContext();
  if ((await second.cookies()).length !== 0)
    throw new Error("browser context isolation smoke failed");
  await second.close();
  await first.close();
  await browser.close();
} finally {
  if (browserServer) await browserServer.close();
  await new Promise((resolve) => server.close(resolve));
}

if (browserServer?.process().exitCode === null)
  throw new Error("browser process tree remained alive after shutdown");
console.log("managed Playwright smoke passed");
