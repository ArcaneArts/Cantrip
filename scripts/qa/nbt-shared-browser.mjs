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
const directory = path.join(root, ".qa", "nbt-shared-" + randomUUID()),
  evidence = process.env.CANTRIP_NBT_QA_EVIDENCE ?? directory;
await mkdir(evidence, { recursive: true });
const config = {
  configFile: path.join(root, "cantrip_app/vite.config.ts"),
  root: path.join(root, "packages/nbt/qa"),
  logLevel: "error",
  build: {
    outDir: path.join(directory, "dist"),
    emptyOutDir: true,
    rolldownOptions: { input: path.join(root, "packages/nbt/qa/shared.html") },
  },
};
await build(config);
const server = await preview({
  ...config,
  preview: { host: "127.0.0.1", port: 0 },
});
try {
  for (const [name, engine] of Object.entries({ chromium, webkit }).filter(
    ([name]) =>
      !process.env.CANTRIP_NBT_QA_ENGINE ||
      process.env.CANTRIP_NBT_QA_ENGINE === name,
  )) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext(),
      errors = [];
    let page;
    try {
      const id = randomUUID(),
        url = `http://127.0.0.1:${server.httpServer.address().port}/shared.html`;
      const open = async () => {
        const view = await context.newPage();
        page = view;
        view.on("pageerror", (error) => errors.push(error.message));
        await view.goto(url);
        await view.waitForFunction(() => window.__nbtSharedQa);
        await view.evaluate((id) => window.__nbtSharedQa.open(id), id);
        await view.waitForFunction(
          () => window.__nbtSharedQa.status().document?.state === "complete",
        );
        return view;
      };
      const a = await open(),
        b = await open();
      await a.waitForFunction(
        () => window.__nbtSharedQa.status().document?.shared?.views === 2,
      );
      assert.equal(
        (await a.evaluate(() => window.__nbtSharedQa.status())).workers +
          (await b.evaluate(() => window.__nbtSharedQa.status())).workers,
        1,
      );
      await a.evaluate(() => window.__nbtSharedQa.edit("9223372036854775807"));
      await b.waitForFunction(
        () => window.__nbtSharedQa.status().edit?.revision === 1,
      );
      assert.equal(
        await b.evaluate(() => window.__nbtSharedQa.value()),
        "9223372036854775807",
      );
      await Promise.all([
        a.evaluate(() => window.__nbtSharedQa.search("a", "number")),
        b.evaluate(() =>
          window.__nbtSharedQa.search("b", "shared-secret-fixture-value"),
        ),
      ]);
      for (const view of [a, b])
        await view.waitForFunction(
          () => window.__nbtSharedQa.searchStatus()?.state === "complete",
        );
      assert.equal(
        (await a.evaluate(() => window.__nbtSharedQa.results("a")))[0].nodeId,
        "node:1",
      );
      assert.equal(
        (await b.evaluate(() => window.__nbtSharedQa.results("b")))[0].nodeId,
        "node:2",
      );
      const workerGeneration = (
        await a.evaluate(() => window.__nbtSharedQa.status())
      ).document.shared.generation;
      await a.evaluate(() => window.__nbtSharedQa.crash());
      for (const view of [a, b])
        await view.waitForFunction((previous) => {
          const status = window.__nbtSharedQa.status().document;
          return (
            status?.shared?.generation > previous &&
            status?.state === "complete" &&
            !status.shared.changing
          );
        }, workerGeneration);
      assert.equal(
        await b.evaluate(() => window.__nbtSharedQa.value()),
        "9223372036854775807",
      );
      await a.evaluate(() => window.__nbtSharedQa.crash(true));
      for (const view of [a, b])
        await view.waitForFunction(
          () =>
            window.__nbtSharedQa.status().document?.shared?.unavailable &&
            !window.__nbtSharedQa.status().document?.shared?.changing,
        );
      await b.evaluate(() => window.__nbtSharedQa.recover());
      for (const view of [a, b])
        await view.waitForFunction(
          () =>
            window.__nbtSharedQa.status().document?.state === "complete" &&
            !window.__nbtSharedQa.status().document?.shared?.changing,
        );
      assert.equal(
        await b.evaluate(() => window.__nbtSharedQa.value()),
        "9223372036854775807",
      );
      await a.evaluate(() => window.__nbtSharedQa.checkpoint());
      const generation = (await b.evaluate(() => window.__nbtSharedQa.status()))
        .document.shared.generation;
      await a.close();
      await b.waitForFunction((previous) => {
        const status = window.__nbtSharedQa.status().document;
        return (
          status?.shared?.generation > previous && status?.state === "complete"
        );
      }, generation);
      assert.equal(
        await b.evaluate(() => window.__nbtSharedQa.value()),
        "9223372036854775807",
      );
      await b.evaluate(() => window.__nbtSharedQa.undo());
      assert.equal(
        await b.evaluate(() => window.__nbtSharedQa.value()),
        "9007199254740993",
      );
      const c = await open();
      await b.evaluate(() => window.__nbtSharedQa.redo());
      await c.waitForFunction(
        () => window.__nbtSharedQa.status().edit?.dirty === true,
      );
      await c.evaluate(() => window.__nbtSharedQa.pause(true));
      await b.evaluate(() => window.__nbtSharedQa.replace());
      await c.waitForFunction(
        () =>
          window.__nbtSharedQa.status().document?.shared?.changing === false &&
          window.__nbtSharedQa.status().edit?.dirty === false,
      );
      assert.equal(
        await c.evaluate(() => window.__nbtSharedQa.value()),
        "9007199254740993",
      );
      await c.evaluate(() => window.__nbtSharedQa.pause(false));
      await c.evaluate(() => window.__nbtSharedQa.edit("42"));
      await c.evaluate(() => window.__nbtSharedQa.close(true));
      assert.equal(await b.evaluate(() => window.__nbtSharedQa.value()), "42");
      await b.evaluate(() => window.__nbtSharedQa.close(true));
      const d = await open();
      assert.equal(
        await d.evaluate(() => window.__nbtSharedQa.value()),
        "9007199254740993",
      );
      for (const view of [b, c, d])
        assert.ok(
          !(await view.evaluate(() => window.__nbtSharedQa.frames())).includes(
            "shared-secret-fixture-value",
          ),
        );
      await d.evaluate(() => window.__nbtSharedQa.close(true));
      assert.deepEqual(errors, []);
      const result = {
        ok: true,
        engine: name,
        oneWorker: true,
        sharedEdits: true,
        independentSearches: true,
        abruptOwnerRecovery: true,
        automaticWorkerRecovery: true,
        manualRecoveryAfterStorageFailure: true,
        recoveredUndo: true,
        inactiveReplacement: true,
        confirmedSharedClose: true,
        encryptedFrames: true,
      };
      await writeFile(
        path.join(evidence, name + "-shared.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
    } catch (error) {
      await writeFile(
        path.join(evidence, name + "-shared-failure.txt"),
        String(error.stack),
      );
      if (page)
        await writeFile(
          path.join(evidence, name + "-shared-state.json"),
          JSON.stringify(
            await page
              .evaluate(async () => ({
                state: window.__nbtSharedQa?.status(),
                locks: await navigator.locks.query(),
              }))
              .catch(() => null),
            null,
            2,
          ),
        );
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.httpServer.close(resolve));
}
