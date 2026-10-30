import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";

const measureOnly = process.argv.includes("--measure-only");
const output = path.resolve("test-results/native-editor-scroll");
await mkdir(output, { recursive: true });
const results = [];
for (const name of (process.env.CANTRIP_QA_BROWSERS ?? "chromium,webkit").split(
  ",",
)) {
  const fixture = await startNativeEditorFixture();
  let browser;
  try {
    browser = await { chromium, webkit }[name].launch({
      headless: true,
      ...(name === "chromium" && process.env.CANTRIP_QA_BROWSER_PATH
        ? { executablePath: process.env.CANTRIP_QA_BROWSER_PATH }
        : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__qaHighlightRequests = 0;
      window.Worker = new Proxy(window.Worker, {
        construct(Target, args) {
          const worker = Reflect.construct(Target, args);
          if (String(args[0]).includes("syntax.worker")) {
            // Keep the real worker/tokenizer, but reproduce a busy worker's
            // delayed replies deterministically while scrolling continues.
            worker.addEventListener("message", (event) => {
              const handler = worker.onmessage;
              event.stopImmediatePropagation();
              setTimeout(() => {
                if (handler && worker.onmessage === handler)
                  handler.call(worker, event);
              }, 40);
            });
            const post = worker.postMessage.bind(worker);
            worker.postMessage = (...message) => {
              window.__qaHighlightRequests++;
              return post(...message);
            };
          }
          return worker;
        },
      });
    });
    await page.goto(fixture.url);
    await page.getByRole("button", { name: "large.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit large.ts" }).waitFor();
    for (const readOnly of [false, true]) {
      if (readOnly)
        await page
          .getByRole("button", { name: "View code", exact: true })
          .click();
      await page.getByRole("textbox").evaluate((input) => {
        input.scrollTop = 0;
        input.scrollLeft = 0;
        input.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await page.locator('[data-editor-line="1"] .syntax-keyword').waitFor();
      const metrics = await page.evaluate(async () => {
        const input = document.querySelector("textarea");
        const originalText = input.value;
        const checkpoints = () =>
          Number(
            document.querySelector('[aria-label="View checkpoints"]')
              .textContent,
          );
        const startCheckpoints = checkpoints();
        const startRequests = window.__qaHighlightRequests;
        const times = [];
        let uncoloredFrames = 0,
          maxMisalignment = 0,
          maxRenderedLines = 0;
        let previous = performance.now();
        for (let i = 0; i < 150; i++) {
          input.scrollTop += 72;
          input.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          times.push(now - previous);
          previous = now;
          const bounds = input.getBoundingClientRect();
          const lines = [...document.querySelectorAll("[data-editor-line]")];
          maxRenderedLines = Math.max(maxRenderedLines, lines.length);
          let colored = true;
          for (const line of lines) {
            const rect = line.getBoundingClientRect();
            if (
              rect.bottom <= bounds.top + 12 ||
              rect.top >= bounds.bottom ||
              !line.textContent.trim()
            )
              continue;
            if (!line.querySelector(".syntax-keyword")) colored = false;
            const expected =
              bounds.top +
              12 +
              (Number(line.dataset.editorLine) - 1) * 24 -
              input.scrollTop;
            maxMisalignment = Math.max(
              maxMisalignment,
              Math.abs(rect.top - expected),
            );
          }
          if (!colored) uncoloredFrames++;
        }
        const duringScrollCheckpoints = checkpoints() - startCheckpoints;
        await new Promise((resolve) => setTimeout(resolve, 250));
        times.sort((a, b) => a - b);
        return {
          frames: times.length,
          uncoloredFrames,
          p95FrameMs: times[Math.floor(times.length * 0.95)],
          maxFrameMs: times.at(-1),
          highlightRequests: window.__qaHighlightRequests - startRequests,
          duringScrollCheckpoints,
          totalCheckpoints: checkpoints() - startCheckpoints,
          maxMisalignment,
          maxRenderedLines,
          contentUnchanged: input.value === originalText,
        };
      });
      results.push({ browser: name, readOnly, ...metrics });
      if (!measureOnly) {
        assert.equal(
          metrics.uncoloredFrames,
          0,
          "Syntax colors must remain visible throughout continuous scrolling",
        );
        assert.ok(
          metrics.highlightRequests < metrics.frames / 4,
          "Scrolling must reuse nearby highlighting rather than request every frame",
        );
        assert.equal(
          metrics.duringScrollCheckpoints,
          0,
          "Continuous scrolling must not rerender the explorer parent each frame",
        );
        assert.equal(
          metrics.totalCheckpoints,
          1,
          "Persist the latest scroll state after scrolling settles",
        );
        assert.ok(
          metrics.maxMisalignment <= 1,
          "Painted lines must track native scrolling",
        );
        assert.ok(
          metrics.maxRenderedLines < 80,
          "Line rendering must remain virtualized",
        );
        assert.ok(
          metrics.contentUnchanged,
          "Scrolling must preserve the document",
        );
      }
    }
    assert.deepEqual(errors, []);
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
