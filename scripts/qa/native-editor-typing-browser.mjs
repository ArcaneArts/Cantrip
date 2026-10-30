import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";

const measureOnly = process.argv.includes("--measure-only");
const output = path.resolve(
  process.env.CANTRIP_QA_OUTPUT ?? "test-results/native-editor-typing",
);
await mkdir(output, { recursive: true });
const results = [];
for (const name of (process.env.CANTRIP_QA_BROWSERS ?? "chromium,webkit").split(
  ",",
)) {
  const fixture = await startNativeEditorFixture();
  let browser;
  try {
    browser = await { chromium, webkit }[name].launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.Worker = new Proxy(window.Worker, {
        construct(Target, args) {
          const worker = Reflect.construct(Target, args);
          if (String(args[0]).includes("syntax.worker"))
            worker.addEventListener("message", (event) => {
              const handler = worker.onmessage;
              event.stopImmediatePropagation();
              setTimeout(() => {
                if (handler && worker.onmessage === handler)
                  handler.call(worker, event);
              }, 100);
            });
          return worker;
        },
      });
    });
    await page.goto(fixture.url);
    await page.getByRole("button", { name: "large.ts", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Edit large.ts" });
    await input.waitFor();
    await input.evaluate((node) => {
      node.focus();
      const offset = node.value.indexOf("2001;");
      node.setSelectionRange(offset, offset);
      node.scrollTop = 2000 * 24;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.locator('[data-editor-line="2002"] .syntax-keyword').waitFor();
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const stats = {
        uncoloredFrames: 0,
        staleTextFrames: 0,
        textareaMutations: 0,
        unaffectedMutations: 0,
        frames: [],
        running: true,
      };
      const lineStart = document
        .querySelector("textarea")
        .value.indexOf("const value2001");
      window.__qaTyping = stats;
      new MutationObserver(
        (changes) => (stats.textareaMutations += changes.length),
      ).observe(document.querySelector("textarea"), {
        subtree: true,
        childList: true,
        characterData: true,
      });
      new MutationObserver(
        (changes) => (stats.unaffectedMutations += changes.length),
      ).observe(document.querySelector('[data-editor-line="2010"]'), {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      let previous = performance.now();
      const frame = () => {
        if (!stats.running) return;
        const now = performance.now();
        stats.frames.push(now - previous);
        previous = now;
        const line = document.querySelector('[data-editor-line="2002"]');
        if (!line?.querySelector(".syntax-keyword")) stats.uncoloredFrames++;
        if (
          line?.textContent !==
          (() => {
            const text = document.querySelector("textarea").value;
            const end = text.indexOf("\n", lineStart);
            return text.slice(lineStart, end < 0 ? text.length : end);
          })()
        )
          stats.staleTextFrames++;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    for (let i = 0; i < 50; i++) {
      await page.keyboard.down("1");
      await page.waitForTimeout(16);
    }
    await page.keyboard.up("1");
    const metrics = await page.evaluate(() => {
      const stats = window.__qaTyping;
      stats.running = false;
      stats.frames.sort((a, b) => a - b);
      return {
        uncoloredFrames: stats.uncoloredFrames,
        staleTextFrames: stats.staleTextFrames,
        textareaMutations: stats.textareaMutations,
        unaffectedMutations: stats.unaffectedMutations,
        frames: stats.frames.length,
        p95FrameMs: stats.frames[Math.floor(stats.frames.length * 0.95)],
      };
    });
    results.push({ browser: name, ...metrics });
    assert.deepEqual(errors, []);
    if (!measureOnly) {
      assert.equal(
        metrics.uncoloredFrames,
        0,
        "Repeated native input must retain syntax paint despite delayed worker replies",
      );
      assert.equal(
        metrics.staleTextFrames,
        0,
        "Input must paint immediately, without buffering text for highlighting",
      );
      assert.equal(
        metrics.textareaMutations,
        0,
        "Do not mirror every edit into the uncontrolled textarea's default text node",
      );
      assert.equal(
        metrics.unaffectedMutations,
        0,
        "Unchanged syntax spans must not be rebuilt on each keystroke",
      );
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
await writeFile(
  path.join(output, measureOnly ? "baseline.json" : "results.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
