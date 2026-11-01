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
const directory = path.join(root, ".qa", "nbt-view-transfer-" + randomUUID()),
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
  for (const [name, engine] of Object.entries({ chromium, webkit }).filter(
    ([name]) =>
      !process.env.CANTRIP_NBT_QA_ENGINE ||
      process.env.CANTRIP_NBT_QA_ENGINE === name,
  )) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 640, height: 850 },
      }),
      page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = () =>
      page.evaluate(() => window.__nbtViewerTransfer.capture());
    const load = async (name) => {
      const epoch = await page
        .locator("main")
        .getAttribute("data-qa-nbt-epoch");
      await page.getByLabel("QA fixture").selectOption(name);
      await page
        .getByRole("button", { name: "Load fixture", exact: true })
        .click();
      await page.waitForFunction(
        (epoch) =>
          document.querySelector("main")?.getAttribute("data-qa-nbt-epoch") !==
          epoch,
        epoch,
      );
      await page
        .locator('[data-nbt-document-state="complete"]')
        .waitFor({ timeout: 180000 });
    };
    const restore = async (state) => {
      const epoch = await page
        .locator("main")
        .getAttribute("data-qa-nbt-epoch");
      await page.evaluate(
        (state) => window.__nbtViewerTransfer.restore(state),
        state,
      );
      await page.waitForFunction(
        (epoch) =>
          document.querySelector("main")?.getAttribute("data-qa-nbt-epoch") !==
          epoch,
        epoch,
      );
      await page
        .locator('[data-nbt-document-state="complete"]')
        .waitFor({ timeout: 180000 });
      await page.waitForFunction(() =>
        window.__nbtViewerTransfer
          .capture()
          .then((state) => state !== undefined),
      );
    };
    const scroll = (label, fraction) =>
      page.getByLabel(label, { exact: true }).evaluate((node, fraction) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction;
      }, fraction);
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/viewer.html?recovery=1`,
      );
      await load("table");
      await page
        .getByRole("button", { name: "Expand items", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[role="treegrid"]')
            ?.getAttribute("aria-rowcount") === "502",
      );
      await scroll("NBT tree rows", 1);
      await page.locator('[aria-rowindex="502"]').click();
      const tree = await capture();
      console.log(
        JSON.stringify({ engine: name, stage: "tree-captured", state: tree }),
      );
      assert.ok(tree.expanded.includes("node:1"));
      assert.ok(tree.tree.position > 400);
      await restore(tree);
      await page
        .locator(
          '[data-nbt-node="' + tree.selected + '"][aria-selected="true"]',
        )
        .waitFor();
      let restored = await capture();
      assert.equal(restored.selected, tree.selected);
      assert.deepEqual(restored.expanded, tree.expanded);
      assert.ok(Math.abs(restored.tree.position - tree.tree.position) < 0.1);
      console.log(JSON.stringify({ engine: name, stage: "tree-restored" }));

      await page.getByRole("treegrid").press("Home");
      await page
        .getByRole("button", { name: "Open table items", exact: true })
        .click();
      await page
        .getByLabel("NBT table order", { exact: true })
        .selectOption("reverse");
      await page.getByLabel("Column sample item", { exact: true }).fill("2");
      await page.getByRole("button", { name: "Use", exact: true }).click();
      await page
        .getByRole("button", { name: "Next fields", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector('[role="columnheader"]')
          ?.parentElement?.textContent?.includes("field7"),
      );
      await page
        .locator("[data-nbt-table] .overflow-x-auto")
        .evaluate((node) => {
          node.scrollLeft = 80;
        });
      await scroll("NBT table rows", 0.5);
      await page.waitForFunction(() =>
        document.querySelector('[data-nbt-table-row="250"]'),
      );
      await page
        .getByRole("button", { name: "Toggle NBT editing", exact: true })
        .click();
      const table = await capture();
      assert.equal(table.table.reverse, true);
      assert.equal(table.table.reference, 2);
      assert.equal(table.table.columnOffset, 8);
      assert.ok(table.table.scrollLeft > 0);
      await restore(table);
      await page.locator('[data-nbt-table-row="250"]').waitFor();
      restored = await capture();
      assert.deepEqual(restored.table, table.table);
      assert.equal(restored.editing, true);
      console.log(JSON.stringify({ engine: name, stage: "table-restored" }));

      await page
        .getByRole("button", { name: "Find in NBT document", exact: true })
        .click();
      await page
        .getByRole("searchbox", { name: "Find in NBT", exact: true })
        .fill("row ");
      await page.locator('[data-nbt-search-status="complete"]').waitFor();
      for (let i = 0; i < 3; i++)
        await page
          .getByRole("searchbox", { name: "Find in NBT", exact: true })
          .press("Enter");
      await page.waitForFunction(() =>
        document
          .querySelector("[data-nbt-search-status]")
          ?.textContent?.startsWith("4 of 500"),
      );
      const find = await capture();
      await restore(find);
      await page.waitForFunction(() =>
        document
          .querySelector('[data-nbt-search-status="complete"]')
          ?.textContent?.startsWith("4 of 500"),
      );
      restored = await capture();
      assert.deepEqual(restored.find, find.find);
      assert.equal(restored.selected, find.selected);
      console.log(JSON.stringify({ engine: name, stage: "find-restored" }));

      await load("large");
      await page
        .getByRole("button", { name: "Toggle NBT editing", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open array array", exact: true })
        .click();
      await page
        .getByLabel("Array element index", { exact: true })
        .fill("104857599");
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await page.locator('[data-nbt-element="104857599"]').waitFor();
      await page
        .getByLabel("Array number format", { exact: true })
        .selectOption("hex");
      await page
        .getByRole("button", {
          name: "Edit array element 104857599",
          exact: true,
        })
        .click();
      await page.getByLabel("NBT edit value", { exact: true }).fill("-7");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.locator('[data-nbt-dirty="true"]').waitFor();
      await page.waitForFunction(() =>
        /f9/i.test(
          document.querySelector('[data-nbt-element="104857599"]')
            ?.textContent ?? "",
        ),
      );
      const array = await capture();
      assert.ok(array.array.firstElement > 104857500);
      assert.equal(array.array.hex, true);
      assert.ok(
        JSON.stringify(array).length < 10000,
        "transfer holds sparse UI state, not source arrays",
      );
      await restore(array);
      await page.locator('[data-nbt-element="104857599"]').waitFor();
      await page.waitForFunction(() =>
        /f9/i.test(
          document.querySelector('[data-nbt-element="104857599"]')
            ?.textContent ?? "",
        ),
      );
      assert.match(
        await page.locator('[data-nbt-element="104857599"]').innerText(),
        /f9/i,
      );
      const beforeNarrow = (await capture()).array.firstElement;
      await page.setViewportSize({ width: 390, height: 850 });
      await page.waitForFunction(
        () =>
          document.querySelector("[data-nbt-array] [data-nbt-scroll] .grid")
            ?.children.length === 2,
      );
      restored = await capture();
      assert.ok(
        Math.abs(restored.array.firstElement - beforeNarrow) < 4,
        "responsive columns preserve the first visible element",
      );
      assert.equal(restored.array.hex, true);
      await page
        .getByLabel("Array element index", { exact: true })
        .fill("104857599");
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await page.locator('[data-nbt-element="104857599"]').waitFor();
      await page.waitForFunction(() =>
        /f9/i.test(
          document.querySelector('[data-nbt-element="104857599"]')
            ?.textContent ?? "",
        ),
      );
      assert.match(
        await page.locator('[data-nbt-element="104857599"]').innerText(),
        /f9/i,
      );
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: path.join(evidence, name + "-view-transfer.png"),
      });
      const result = {
        ok: true,
        engine: name,
        tree: true,
        table: true,
        find: true,
        edited100MiBArray: true,
        responsiveArrayAnchor: true,
        transferBytes: JSON.stringify(array).length,
      };
      await writeFile(
        path.join(evidence, name + "-view-transfer.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
    } catch (error) {
      await page
        .screenshot({
          path: path.join(evidence, name + "-view-transfer-failure.png"),
        })
        .catch(() => {});
      await writeFile(
        path.join(evidence, name + "-view-transfer-failure.txt"),
        String(error.stack) + "\n" + (await page.locator("body").innerText()),
      );
      await writeFile(
        path.join(evidence, name + "-view-transfer-failure-state.json"),
        JSON.stringify(await capture(), null, 2),
      );
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await server.close();
}
