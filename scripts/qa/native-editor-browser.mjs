import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";
import {
  checkNativeEditorInput,
  checkNativeEditorLongLine,
  checkNativeEditorReadOnly,
  checkNativeEditorGutterHover,
  measureNativeInputPaint,
} from "./native-editor-input-acceptance.mjs";

const results = [];
const output = path.resolve("test-results/native-editor");
await mkdir(output, { recursive: true });
for (const [name, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startNativeEditorFixture();
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 800 },
        hasTouch: mobile,
      });
      await context.addInitScript(() => {
        const stats = { active: 0, created: 0 };
        window.__qaSyntaxWorkers = stats;
        window.Worker = new Proxy(window.Worker, {
          construct(Target, args) {
            const worker = Reflect.construct(Target, args);
            let tracked = String(args[0]).includes("syntax.worker");
            if (tracked) {
              stats.active++;
              stats.created++;
            }
            const terminate = worker.terminate.bind(worker);
            worker.terminate = () => {
              if (tracked) {
                stats.active--;
                tracked = false;
              }
              terminate();
            };
            return worker;
          },
        });
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const resources = [];
      page.on("request", (request) => resources.push(request.url()));
      const started = performance.now();
      await page.goto(fixture.url);
      const input = page.getByRole("textbox");
      await input.waitFor();
      const openMs = performance.now() - started;
      await page.locator(".syntax-keyword").first().waitFor();
      assert.equal(
        await page.evaluate(() => window.__qaSyntaxWorkers.active),
        1,
      );
      await page
        .getByRole("button", { name: "Hide editor", exact: true })
        .click();
      await page.waitForFunction(
        () => window.__qaSyntaxWorkers.active === 0,
        undefined,
        {
          timeout: 3000,
        },
      );
      await page
        .getByRole("button", { name: "Show editor", exact: true })
        .click();
      await page.waitForFunction(() => window.__qaSyntaxWorkers.active === 1);
      const original = await input.inputValue();
      const gutterAcceptance = await checkNativeEditorGutterHover(page);
      await input.focus();
      await input.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
      await input.pressSequentially("// saved marker");
      await input.press("ControlOrMeta+s");
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Save state"]').textContent ===
          "saved",
      );
      assert.match(
        await readFile(path.join(fixture.directory, "main.tsx"), "utf8"),
        /saved marker/,
      );
      await input.pressSequentially("😀é");
      await input.press("ControlOrMeta+z");
      await input.press("ControlOrMeta+Shift+z");
      assert.match(await input.inputValue(), /😀é$/u);
      const draft = await input.inputValue();
      await page.getByRole("button", { name: "other.py", exact: true }).click();
      await page.getByRole("textbox", { name: "Edit other.py" }).waitFor();
      const warmSwitchStarted = performance.now();
      await page.getByRole("button", { name: "main.tsx", exact: true }).click();
      assert.equal(
        await page.getByRole("textbox", { name: "Edit main.tsx" }).inputValue(),
        draft,
      );
      const warmSwitchMs = performance.now() - warmSwitchStarted;
      await input.press("ControlOrMeta+z");
      assert.notEqual(await input.inputValue(), draft);
      await input.press("ControlOrMeta+Shift+z");
      assert.equal(await input.inputValue(), draft);
      const readOnlyAcceptance = await checkNativeEditorReadOnly(
        page,
        fixture,
        {
          screenshotPath: path.join(
            output,
            `${name}-${mobile ? "phone" : "desktop"}-readonly.png`,
          ),
        },
      );
      const inputAcceptance = await checkNativeEditorInput(
        page,
        fixture,
        path.join(output, `${name}-${mobile ? "phone" : "desktop"}-input.png`),
      );
      await writeFile(
        path.join(fixture.directory, "main.tsx"),
        "external change\n",
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('[aria-label="Error"]')
          .textContent.includes("externally"),
      );
      assert.equal(await input.inputValue(), draft);
      assert.equal(
        await readFile(path.join(fixture.directory, "main.tsx"), "utf8"),
        "external change\n",
      );
      await page.getByRole("button", { name: "large.ts", exact: true }).click();
      await page.getByRole("textbox", { name: "Edit large.ts" }).waitFor();
      const scrollStarted = performance.now();
      await input.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll"));
      });
      await page.locator('[data-editor-line="20001"]').waitFor();
      const finalLine = await page
        .locator('[data-editor-line="20001"]')
        .boundingBox();
      const inputBounds = await input.boundingBox();
      assert.ok(
        finalLine.y + finalLine.height <=
          inputBounds.y + inputBounds.height + 1,
        "The final empty line must be visible at the end of scrolling",
      );
      const scrollMs = performance.now() - scrollStarted;
      await page
        .locator('[data-editor-line="20000"] .syntax-keyword')
        .waitFor();
      const highlightMs = performance.now() - scrollStarted;
      assert.ok((await page.locator("[data-editor-line]").count()) < 80);
      const metrics = await input.evaluate((node) => {
        const paint = document.querySelector(".cantrip-editor-code"),
          gutter = document.querySelector(".cantrip-editor-gutter");
        const style = getComputedStyle(node),
          paintStyle = getComputedStyle(paint);
        return {
          inputFont: style.fontFamily,
          paintFont: paintStyle.fontFamily,
          inputLineHeight: style.lineHeight,
          paintLineHeight: paintStyle.lineHeight,
          gutterWidth: gutter.getBoundingClientRect().width,
          fontSize: style.fontSize,
        };
      });
      assert.equal(metrics.inputFont, metrics.paintFont);
      assert.equal(metrics.inputLineHeight, metrics.paintLineHeight);
      assert.ok(metrics.gutterWidth > 0);
      if (mobile) assert.equal(metrics.fontSize, "16px");
      const longLineAcceptance = await checkNativeEditorLongLine(page, input);
      const retainedPosition = await input.evaluate((node) => {
        node.setSelectionRange(
          node.value.length - 10,
          node.value.length - 5,
          "backward",
        );
        node.dispatchEvent(new Event("select", { bubbles: true }));
        return [
          node.scrollTop,
          node.scrollLeft,
          node.selectionStart,
          node.selectionEnd,
          node.selectionDirection,
        ];
      });
      await page
        .getByRole("button", { name: "Hide editor", exact: true })
        .click();
      await page.waitForFunction(() => window.__qaSyntaxWorkers.active === 0);
      await page
        .getByRole("button", { name: "Show editor", exact: true })
        .click();
      await input.waitFor();
      assert.deepEqual(
        await input.evaluate((node) => [
          node.scrollTop,
          node.scrollLeft,
          node.selectionStart,
          node.selectionEnd,
          node.selectionDirection,
        ]),
        retainedPosition,
      );
      await input.focus();
      await input.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
      const largeBeforeTyping = await input.inputValue();
      const largeInputToPaintMs = await measureNativeInputPaint(page, "x");
      assert.equal(await input.inputValue(), largeBeforeTyping + "x");
      await input.press("ControlOrMeta+z");
      assert.equal(await input.inputValue(), largeBeforeTyping);
      assert.deepEqual(errors, []);
      assert.equal(
        resources.some((url) =>
          /monaco|code-attachments|code-session/u.test(url),
        ),
        false,
      );
      await page.screenshot({
        path: path.join(output, `${name}-${mobile ? "phone" : "desktop"}.png`),
      });
      results.push({
        browser: name,
        layout: mobile ? "phone viewport" : "desktop",
        openMs,
        scrollMs,
        highlightMs,
        warmSwitchMs,
        largeInputToPaintMs,
        visibleLines: await page.locator("[data-editor-line]").count(),
        initialCharacters: original.length,
        inputAcceptance,
        gutterAcceptance,
        readOnlyAcceptance,
        longLineAcceptance,
        status: "pass",
      });
      await context.close();
      // Each context receives fresh disk content and revision.
      await writeFile(path.join(fixture.directory, "main.tsx"), original);
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
