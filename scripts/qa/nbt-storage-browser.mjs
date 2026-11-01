import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright-core";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  appRequire = createRequire(path.join(root, "cantrip_app/package.json"));
const { build, preview } = await import(appRequire.resolve("vite"));
const directory = path.join(root, ".qa", `nbt-storage-${randomUUID()}`),
  output = process.env.CANTRIP_NBT_QA_EVIDENCE ?? directory;
await mkdir(output, { recursive: true });
const config = {
  configFile: false,
  root: path.join(root, "packages/nbt/qa"),
  logLevel: "error",
  build: {
    outDir: path.join(directory, "dist"),
    emptyOutDir: true,
    rolldownOptions: { input: path.join(root, "packages/nbt/qa/storage.html") },
  },
};
await build(config);
const server = await preview({
  ...config,
  preview: { host: "127.0.0.1", port: 0 },
});
try {
  const port = server.httpServer.address().port;
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launchPersistentContext(
      path.join(directory, `${name}-profile`),
      { headless: true },
    );
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/storage.html`);
      await page.waitForFunction(() => window.__nbtStorageResult, undefined, {
        timeout: 240000,
      });
      const result = await page.evaluate(() => window.__nbtStorageResult);
      await writeFile(
        path.join(output, `${name}-storage.json`),
        JSON.stringify(result, null, 2),
      );
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
      console.log(JSON.stringify({ engine: name, ...result }));
    } finally {
      await browser.close();
    }
    const privateBrowser = await engine.launch({ headless: true });
    try {
      const page = await privateBrowser.newPage();
      await page.goto(`http://127.0.0.1:${port}/storage.html?automatic`);
      await page.waitForFunction(() => window.__nbtStorageResult, undefined, {
        timeout: 240000,
      });
      const result = await page.evaluate(() => window.__nbtStorageResult);
      await writeFile(
        path.join(output, `${name}-automatic-storage.json`),
        JSON.stringify(result, null, 2),
      );
      assert.equal(
        result.ok,
        true,
        `${name} automatic: ${JSON.stringify(result)}`,
      );
      console.log(
        JSON.stringify({ engine: name, mode: "automatic", ...result }),
      );
    } finally {
      await privateBrowser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.httpServer.close(resolve));
}
