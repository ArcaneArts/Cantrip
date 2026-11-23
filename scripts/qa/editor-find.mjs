import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";

const output = path.resolve("test-results/editor-find");
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startNativeEditorFixture();
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
    for (const phone of [false, true]) {
      const context = await browser.newContext({
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 850 },
        colorScheme: engine === "chromium" ? "dark" : "light",
      });
      await context.addInitScript(() => {
        window.__qaFindWorkers = { created: 0, active: 0, searches: 0 };
        const Original = window.Worker;
        window.Worker = new Proxy(Original, {
          construct(Target, args) {
            const worker = Reflect.construct(Target, args),
              tracked = String(args[0]).includes("find.worker");
            if (tracked) {
              window.__qaFindWorkers.created++;
              window.__qaFindWorkers.active++;
              const post = worker.postMessage.bind(worker),
                terminate = worker.terminate.bind(worker);
              let retired = false;
              worker.postMessage = (message, ...rest) => {
                if (message.type === "search")
                  window.__qaFindWorkers.searches++;
                return post(message, ...rest);
              };
              worker.terminate = () => {
                if (!retired) {
                  retired = true;
                  window.__qaFindWorkers.active--;
                }
                return terminate();
              };
            }
            return worker;
          },
        });
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.url);
      const input = page.locator(".cantrip-editor-input");
      await input.waitFor();
      if (engine === "chromium")
        await page.getByRole("button", { name: "Theme", exact: true }).click();
      const text = "const needle = 1;\nconst next = 'Needle';\n// needle\n";
      await input.fill(text);
      await input.evaluate((node) => {
        node.setSelectionRange(0, 0);
        window.__qaFindInput = node;
      });
      const writes = fixture.requests.filter(
        (request) => request.method === "PUT",
      ).length;
      const shortcut = engine === "chromium" ? "Meta+f" : "Control+f";
      await page.getByRole("button", { name: "main.tsx", exact: true }).focus();
      await page.keyboard.press(shortcut);
      const chip = page.getByRole("group", {
        name: "Find in file",
        exact: true,
      });
      const query = chip.getByRole("textbox", {
        name: "Find in file",
        exact: true,
      });
      await query.waitFor();
      assert.equal(
        await query.evaluate((node) => node === document.activeElement),
        true,
      );
      await query.fill("needle");
      await chip.getByRole("status").filter({ hasText: "1 of 3" }).waitFor();
      assert.deepEqual(
        await input.evaluate((node) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
        [6, 12],
      );
      assert.equal(
        await query.evaluate((node) => node === document.activeElement),
        true,
      );
      await query.press("Enter");
      await chip.getByRole("status").filter({ hasText: "2 of 3" }).waitFor();
      await query.press("Shift+Enter");
      await chip.getByRole("status").filter({ hasText: "1 of 3" }).waitFor();
      await query.press("Shift+Enter");
      await chip.getByRole("status").filter({ hasText: "3 of 3" }).waitFor();
      await query.press("Enter");
      await chip.getByRole("status").filter({ hasText: "1 of 3" }).waitFor();
      await chip
        .getByRole("button", { name: "Next match", exact: true })
        .click();
      await chip.getByRole("status").filter({ hasText: "2 of 3" }).waitFor();
      assert.equal(
        await query.evaluate((node) => node === document.activeElement),
        true,
      );
      await query.press("Shift+Enter");
      await chip.getByRole("status").filter({ hasText: "1 of 3" }).waitFor();
      assert.equal(await input.inputValue(), text);
      const editor = page.locator("[data-native-code-editor]"),
        box = await chip.boundingBox(),
        panel = await editor.boundingBox();
      const activeHit = await page
        .locator("[data-find-active]")
        .first()
        .boundingBox();
      assert.ok(
        activeHit.y >= box.y + box.height ||
          activeHit.x + activeHit.width <= box.x,
        "the chip never covers the selected match",
      );
      assert.ok(
        box.width <= 375 &&
          box.x >= panel.x &&
          box.x + box.width <= panel.x + panel.width + 1,
        "compact chip stays inside the editor",
      );
      await page.screenshot({
        path: path.join(
          output,
          `${engine}-${phone ? "phone" : "desktop"}-edit.png`,
        ),
      });
      await query.press("Escape");
      await chip.waitFor({ state: "hidden" });
      assert.equal(
        await input.evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(
        await input.evaluate((node) => node === window.__qaFindInput),
        true,
      );
      await input.press(shortcut);
      await query.waitFor();
      assert.equal(
        await query.inputValue(),
        "needle",
        "selected match seeds the find input",
      );
      await query.fill("[a.*]");
      await chip.getByRole("status").filter({ hasText: "0 of 0" }).waitFor();
      assert.equal(
        await chip
          .getByRole("button", { name: "Next match", exact: true })
          .isDisabled(),
        true,
      );
      await query.press("Escape");
      await page
        .getByRole("button", { name: "View code", exact: true })
        .click();
      assert.equal(await input.evaluate((node) => node.readOnly), true);
      await input.focus();
      await input.press(shortcut);
      await query.fill("NEEDLE");
      await chip.getByRole("status").filter({ hasText: "1 of 3" }).waitFor();
      await query.press("Enter");
      await chip.getByRole("status").filter({ hasText: "2 of 3" }).waitFor();
      assert.equal(await input.inputValue(), text);
      assert.equal(
        fixture.requests.filter((request) => request.method === "PUT").length,
        writes,
      );
      await page.screenshot({
        path: path.join(
          output,
          `${engine}-${phone ? "phone" : "desktop"}-view.png`,
        ),
      });
      await query.press("Escape");
      await page
        .getByRole("button", { name: "Edit code", exact: true })
        .click();
      await input.focus();
      await input.press("ControlOrMeta+z");
      assert.notEqual(
        await input.inputValue(),
        text,
        "find did not add undo entries",
      );
      await input.press("ControlOrMeta+Shift+z");
      assert.equal(await input.inputValue(), text);
      await input.press(shortcut);
      await query.fill("needle");
      await chip.getByRole("status").filter({ hasText: "of 3" }).waitFor();
      await input.focus();
      await input.evaluate((node) =>
        node.setSelectionRange(node.value.length, node.value.length),
      );
      await input.pressSequentially("// typing while find is open");
      await chip.getByRole("status").filter({ hasText: "of 3" }).waitFor();
      assert.equal(
        await input.evaluate((node) => node.selectionStart),
        await input.evaluate((node) => node.value.length),
        "background match updates never move the typing caret",
      );
      await input.press("Escape");
      // A match outside the current row window and far along a long line must be revealed.
      await page.getByRole("button", { name: "large.ts", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Edit large.ts", exact: true })
        .waitFor();
      await input.evaluate((node) => node.setSelectionRange(0, 0));
      await input.press(shortcut);
      await query.fill("const");
      await chip
        .getByRole("status")
        .filter({ hasText: "1 of 20,000" })
        .waitFor();
      await query.press("Shift+Enter");
      await chip
        .getByRole("status")
        .filter({ hasText: "20,000 of 20,000" })
        .waitFor();
      await page
        .locator('[data-editor-line="20000"] [data-find-active]')
        .waitFor();
      assert.ok(await input.evaluate((node) => node.scrollTop > 100_000));
      await query.press("Escape");
      await input.fill("x".repeat(20_000) + "TARGET_END\n");
      await input.evaluate((node) => {
        node.setSelectionRange(0, 0);
        node.scrollLeft = 0;
      });
      await input.press(shortcut);
      await query.fill("TARGET_END");
      await chip.getByRole("status").filter({ hasText: "1 of 1" }).waitFor();
      await page.waitForFunction(
        () => document.querySelector(".cantrip-editor-input").scrollLeft > 1000,
      );
      const mark = page.locator("[data-find-active]").first();
      const hit = await mark.boundingBox(),
        bounds = await input.boundingBox();
      assert.ok(
        hit.x + hit.width > bounds.x && hit.x < bounds.x + bounds.width,
        "the current match is horizontally visible",
      );
      const searches = await page.evaluate(
        () => window.__qaFindWorkers.searches,
      );
      await input.evaluate((node) => {
        node.scrollLeft = Math.max(0, node.scrollLeft - 50);
        node.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(350);
      assert.equal(
        await page.evaluate(() => window.__qaFindWorkers.searches),
        searches,
        "passive scroll does not rescan text",
      );
      await page
        .getByRole("button", { name: "Hide editor", exact: true })
        .click();
      await page.waitForFunction(() => window.__qaFindWorkers.active === 0);
      await page
        .getByRole("button", { name: "Show editor", exact: true })
        .click();
      await query.waitFor();
      await chip.getByRole("status").filter({ hasText: "1 of 1" }).waitFor();
      await query.press("Escape");
      await page.waitForFunction(() => window.__qaFindWorkers.active === 0);
      assert.deepEqual(errors, []);
      results.push({
        engine,
        layout: phone ? "phone" : "desktop",
        edit: true,
        view: true,
        counts: true,
        wraparound: true,
        focus: true,
        undoPreserved: true,
        verticalReveal: true,
        horizontalReveal: true,
        idleRescans: 0,
        retiredWorkers: true,
        errors,
      });
      await context.close();
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
await writeFile(
  path.join(output, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
