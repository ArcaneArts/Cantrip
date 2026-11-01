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
const directory = path.join(root, ".qa", "nbt-viewer-" + randomUUID()),
  evidence = process.env.CANTRIP_NBT_QA_EVIDENCE ?? directory;
await mkdir(evidence, { recursive: true });
const config = {
  configFile: path.join(root, "cantrip_app/vite.config.ts"),
  root: path.join(root, "packages/nbt/qa"),
  logLevel: "error",
  resolve: {
    alias: {
      react: path.dirname(appRequire.resolve("react/package.json")),
      "react-dom": path.dirname(appRequire.resolve("react-dom/package.json")),
    },
  },
  build: {
    outDir: path.join(directory, "dist"),
    emptyOutDir: true,
    rolldownOptions: { input: path.join(root, "packages/nbt/qa/viewer.html") },
  },
};
await build(config);
const server = await preview({
  ...config,
  preview: { host: "127.0.0.1", port: 0 },
});
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const context = await engine.launchPersistentContext(
        path.join(directory, name + "-profile"),
        { headless: true, viewport: { width: 1280, height: 850 } },
      ),
      page = await context.newPage(),
      results = [];
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const record = (test, details) => {
      results.push({ test, details });
      console.log(JSON.stringify({ engine: name, test, details }));
    };
    const load = async (name) => {
      await page.getByLabel("QA fixture").selectOption(name);
      await page
        .getByRole("button", { name: "Load fixture", exact: true })
        .click();
      await page
        .locator('[data-nbt-document-state="complete"]')
        .waitFor({ timeout: 240000 });
    };
    const find = page.getByRole("searchbox", {
      name: "Find in NBT",
      exact: true,
    });
    const search = async (text) => {
      await find.fill(text);
      await page
        .locator('[data-nbt-search-status="complete"]')
        .waitFor({ timeout: 240000 });
    };
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/viewer.html`,
      );
      await load("large");
      assert.equal(
        await page
          .getByRole("button", { name: "Expand hidden", exact: true })
          .count(),
        1,
      );
      await page.getByRole("treegrid").focus();
      await page.keyboard.press("ControlOrMeta+f");
      await find.waitFor();
      const started = performance.now();
      await search("TAIL_NEEDLE");
      const searchMs = performance.now() - started;
      assert.match(
        await page.locator('[data-nbt-search-status="complete"]').innerText(),
        /1 of 2 found/,
      );
      await page.locator('[data-nbt-node="node:3"]').waitFor();
      await find.press("Enter");
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-nbt-node="node:5"]')
            ?.getAttribute("aria-selected") === "true",
      );
      await find.press("Shift+Enter");
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-nbt-node="node:3"]')
            ?.getAttribute("aria-selected") === "true",
      );
      record("100MiB-unexpanded-search", {
        searchMs,
        expandedMiB: 100,
        results: 2,
        maxRead: (await page.evaluate(() => window.__nbtViewerStatistics))
          .maxRead,
      });
      await page.getByText("Find options", { exact: true }).click();
      await page.getByLabel("Exact number", { exact: true }).check();
      await search("9007199254740993");
      assert.match(
        await page.locator('[data-nbt-search-status="complete"]').innerText(),
        /1 of 1 found/,
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-nbt-node="node:4"]')
            ?.getAttribute("aria-selected") === "true",
      );
      record("exact-long", "Find preserves values beyond 2^53");
      await page
        .getByRole("button", { name: "Close NBT find", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open array array", exact: true })
        .click();
      await page.locator('[data-nbt-element="0"]').waitFor();
      await page
        .getByLabel("Array element index", { exact: true })
        .fill("104857599");
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-nbt-element="104857599"]')
          ?.textContent?.includes("42"),
      );
      assert.ok((await page.locator("[data-nbt-element]").count()) < 500);
      await page
        .getByLabel("Array number format", { exact: true })
        .selectOption("hex");
      await page.waitForFunction(() =>
        document
          .querySelector('[data-nbt-element="104857599"]')
          ?.textContent?.includes("0x2a"),
      );
      record("virtual-array-last-element", {
        elements: 104857600,
        renderedCells: await page.locator("[data-nbt-element]").count(),
      });
      await page.screenshot({ path: path.join(evidence, name + "-array.png") });
      await page.getByRole("button", { name: "Tree", exact: true }).click();
      await page
        .getByRole("button", { name: "Collapse hidden", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Collapse Root", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-nbt-node]").length === 1,
      );
      await page.getByRole("treegrid").press("ArrowRight");
      await page
        .getByRole("button", { name: "Expand hidden", exact: true })
        .waitFor();
      await page.getByRole("treegrid").press("End");
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-nbt-node="node:2"]')
            ?.getAttribute("aria-selected") === "true",
      );
      record(
        "tree-keyboard",
        "Collapse, expand and last-row selection remain usable after clicking actions",
      );
      await page.evaluate(() => {
        const node = document.querySelector("[data-nbt-viewer]");
        window.__nbtMutations = 0;
        window.__nbtObserver = new MutationObserver(
          (records) => (window.__nbtMutations += records.length),
        );
        window.__nbtObserver.observe(node, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => (window.__nbtMutations = 0));
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => window.__nbtMutations), 0);
      await page.evaluate(() => window.__nbtObserver.disconnect());
      record(
        "idle",
        "No periodic viewer DOM mutations after indexing finishes",
      );
      await load("table");
      await page
        .getByRole("button", { name: "Open table items", exact: true })
        .click();
      await page
        .getByRole("cell", { name: "typed 1 String", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("columnheader", { name: "duplicate", exact: true })
          .count(),
        2,
      );
      await page
        .getByLabel("NBT table order", { exact: true })
        .selectOption("reverse");
      await page
        .getByRole("button", { name: "Select item 499", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Next fields", exact: true })
        .click();
      await page
        .getByRole("columnheader", { name: "field7", exact: true })
        .waitFor();
      await page.screenshot({ path: path.join(evidence, name + "-table.png") });
      record(
        "typed-table",
        "Reordered names, duplicate names, varying cell types, paged columns and reverse display",
      );
      await load("bedrock");
      await page.getByRole("row").filter({ hasText: "little" }).waitFor();
      record("bedrock-envelope", "Automatic level.dat envelope detection");
      await page.getByLabel("QA fixture").selectOption("network");
      await page
        .getByRole("button", { name: "Load fixture", exact: true })
        .click();
      await page
        .getByLabel("NBT encoding", { exact: true })
        .selectOption("network");
      await page.locator('[data-nbt-document-state="complete"]').waitFor();
      await page.getByRole("row").filter({ hasText: "network" }).waitFor();
      record(
        "explicit-network",
        "Explicit little-varint profile can reopen a source",
      );
      await page.getByLabel("QA fixture").selectOption("broken");
      await page
        .getByRole("button", { name: "Load fixture", exact: true })
        .click();
      await page.getByRole("alert").first().waitFor();
      record(
        "malformed",
        "Parser diagnostics are visible beside format controls",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByLabel("Choose local NBT file", { exact: true })
        .setInputFiles({
          name: "phone-local.nbt",
          mimeType: "application/octet-stream",
          buffer: Buffer.from([
            10, 0, 0, 3, 0, 5, 108, 111, 99, 97, 108, 0, 0, 0, 42, 0,
          ]),
        });
      await page.locator('[data-nbt-document-state="complete"]').waitFor();
      await page.getByRole("row").filter({ hasText: "local" }).waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(evidence, name + "-narrow.png"),
      });
      record(
        "narrow-local-file",
        "390px layout and ordinary browser file input, not real-device qualification",
      );
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByLabel("Active viewer", { exact: true }).uncheck();
      await page.getByLabel("QA fixture").selectOption("large");
      await page
        .getByRole("button", { name: "Load fixture", exact: true })
        .click();
      await page
        .locator('[data-nbt-document-state="paused"]')
        .waitFor({ timeout: 30000 });
      await page.waitForTimeout(150);
      const before = await page.evaluate(() => ({
        reads: window.__nbtViewerStatistics.reads,
        status: document.querySelector("[data-nbt-document-state]")
          ?.textContent,
      }));
      await page.waitForTimeout(250);
      assert.deepEqual(
        await page.evaluate(() => ({
          reads: window.__nbtViewerStatistics.reads,
          status: document.querySelector("[data-nbt-document-state]")
            ?.textContent,
        })),
        before,
      );
      await page.getByLabel("Active viewer", { exact: true }).check();
      await page
        .locator('[data-nbt-document-state="complete"]')
        .waitFor({ timeout: 240000 });
      record(
        "inactive-pause",
        "Source reads and indexing stop for an inactive view and resume without reopening",
      );
      await page
        .getByRole("button", { name: "Find in NBT document", exact: true })
        .click();
      await page.getByText("Find options", { exact: true }).click();
      await page.getByLabel("Types", { exact: true }).check();
      await page.getByLabel("Names", { exact: true }).uncheck();
      await page.getByLabel("Values", { exact: true }).uncheck();
      await find.fill("Byte");
      await page.waitForFunction(() =>
        document
          .querySelector('[data-nbt-search-status="searching"]')
          ?.textContent?.match(/[1-9]/),
      );
      await page.getByLabel("Values", { exact: true }).check();
      await page.getByLabel("Types", { exact: true }).uncheck();
      const cancellation = performance.now();
      await search("TAIL_NEEDLE");
      assert.ok(performance.now() - cancellation < 1000);
      record("search-cancellation", {
        replaceMillionElementQueryMs: performance.now() - cancellation,
      });
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, name + "-viewer.json"),
        JSON.stringify({ ok: true, results }, null, 2),
      );
    } catch (error) {
      await page
        .screenshot({ path: path.join(evidence, name + "-failure.png") })
        .catch(() => {});
      await writeFile(
        path.join(evidence, name + "-failure.txt"),
        String(error.stack) + "\n" + (await page.locator("body").innerText()),
      );
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await new Promise((resolve) => server.httpServer.close(resolve));
}
