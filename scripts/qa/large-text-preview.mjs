import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const output = path.resolve("test-results/large-text-preview");
await mkdir(output, { recursive: true });
const limit = 10 * 1024 * 1024;
const prefix = "let x=0;\n".repeat(10_000);
const footer = "\n// SENTINEL_FINAL_PREVIEW_LINE";
const row = `// ${"text ".repeat(20)}\n`;
const rest = limit - prefix.length - footer.length;
const content =
  prefix +
  row.repeat(Math.floor(rest / row.length)) +
  "x".repeat(rest % row.length) +
  footer;
assert.equal(Buffer.byteLength(content), limit);
const results = [];
for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser;
  try {
    const file = path.join(
      fixture.repositorySeed.repository,
      "SENTINEL-large.ts",
    );
    await writeFile(file, content);
    await writeFile(
      path.join(fixture.repositorySeed.repository, "too-large.txt"),
      "a".repeat(limit + 1),
    );
    browser = await browserType.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 850 },
      colorScheme: engine === "chromium" ? "dark" : "light",
    });
    const errors = [],
      operations = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        /\/file-documents\/[^/]+\/operation$/u.test(
          new URL(request.url()).pathname,
        )
      ) {
        assert.ok(
          !request.postData()?.includes("SENTINEL"),
          "file paths and text stay encrypted on the relay",
        );
        operations.push(request.url());
      }
    });
    await page.goto(fixture.origin);
    const save = page.getByRole("button", {
      name: "Save recovery file",
      exact: true,
    });
    await save.waitFor({ timeout: 90_000 });
    const download = page.waitForEvent("download");
    await save.click();
    await (
      await download
    ).saveAs(path.join(fixture.directory, "recovery.json"));
    await page
      .getByRole("checkbox", {
        name: "I saved the recovery file somewhere I can access later.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Continue to Cantrip", exact: true })
      .click();
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await page.evaluate(() => window.__qaRepositoryFixture.create());
        break;
      } catch (error) {
        if (
          Date.now() > deadline ||
          !error.message.includes("protected server connection is unavailable")
        )
          throw error;
        await delay(1000);
      }
    }
    await page.waitForFunction(
      async () =>
        (await window.__qaRepositoryFixture.project())?.setupStatus === "ready",
      undefined,
      { timeout: 90_000 },
    );
    await page
      .getByRole("button", { name: "Chat. Switch Cantrip mode", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Cantrip IDE", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Switch project", exact: true })
      .click();
    await page
      .locator('[data-slot="project-switcher-project"]')
      .filter({ hasText: fixture.repositorySeed.name })
      .click();
    await page
      .getByRole("treeitem", { name: "SENTINEL-large.ts", exact: true })
      .waitFor({ timeout: 90_000 });
    const started = performance.now();
    await page
      .getByRole("treeitem", { name: "SENTINEL-large.ts", exact: true })
      .click();
    const preview = page.locator("[data-text-preview]:visible");
    const input = preview.getByRole("textbox", {
      name: "View SENTINEL-large.ts",
      exact: true,
    });
    await input.waitFor({ timeout: 30_000 });
    const openMs = performance.now() - started;
    await preview.locator(".syntax-keyword").first().waitFor();
    const initial = await input.evaluate((node) => ({
      bytes: node.value.length,
      lines: node.value.split("\n").length,
      readonly: node.readOnly,
    }));
    assert.equal(initial.bytes, prefix.length);
    assert.equal(initial.lines, 10_001);
    assert.equal(initial.readonly, true);
    assert.ok(
      (await preview.locator("[data-editor-line]").count()) < 100,
      "only visible rows are painted",
    );
    assert.equal(
      operations.length,
      2,
      "one full-read fallback followed by one page, with no retries",
    );
    await page.screenshot({
      path: path.join(output, `${engine}-first-page.png`),
    });
    const idleReads = operations.length;
    await delay(1200);
    assert.equal(
      operations.length,
      idleReads,
      "no idle polling or eager whole-file loading",
    );
    const before = await input.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
      return node.scrollTop;
    });
    await page.waitForFunction(
      () =>
        document.querySelector(
          "[data-text-preview]:not([aria-hidden]) textarea",
        )?.value.length > 90_000,
    );
    await preview
      .getByRole("status")
      .filter({ hasText: "Loading" })
      .waitFor({ state: "hidden" });
    assert.ok(
      Math.abs((await input.evaluate((node) => node.scrollTop)) - before) < 2,
      "appending preserves scroll position",
    );
    // Finishing via the explicit action also supports files with very long lines.
    while (
      !(await preview.getByRole("status").textContent()).includes(
        "All text loaded",
      )
    ) {
      await preview
        .getByRole("button", { name: "Load more", exact: true })
        .click();
      await preview
        .getByRole("status")
        .filter({ hasText: "Loading" })
        .waitFor({ state: "hidden" });
    }
    assert.equal(await input.evaluate((node) => node.value.length), limit);
    assert.ok(
      await input.evaluate((node) =>
        node.value.endsWith("SENTINEL_FINAL_PREVIEW_LINE"),
      ),
    );
    await input.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await preview
      .locator("[data-editor-line]")
      .filter({ hasText: "SENTINEL_FINAL_PREVIEW_LINE" })
      .waitFor();
    await page.screenshot({
      path: path.join(output, `${engine}-last-page.png`),
    });
    const readCount = operations.length;
    assert.equal(
      readCount,
      42,
      "each byte range is read once despite background filesystem events",
    );
    console.log(
      JSON.stringify({
        engine,
        openMs,
        initial,
        readCount,
        stage: "all-pages-loaded",
      }),
    );
    assert.equal(
      await readFile(file, "utf8"),
      content,
      "preview never rewrites the file",
    );
    // Refresh starts a new snapshot, and a changed continuation is surfaced.
    const controls = page.getByRole("toolbar", {
      name: "File controls",
      exact: true,
    });
    await controls.getByRole("button", { name: /Refresh/ }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-text-preview] textarea")?.value.length ===
        90_000,
    );
    await writeFile(file, content.replace("let x=0;", "let y=0;"));
    await preview
      .getByRole("button", { name: "Load more", exact: true })
      .click();
    await preview
      .getByRole("status")
      .filter({ hasText: "file changed" })
      .waitFor();
    await page.screenshot({
      path: path.join(output, `${engine}-changed-file.png`),
    });
    await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Edit qa.txt", exact: true })
      .waitFor();
    const largeOperationUrl = operations[0];
    const hiddenReads = operations.filter(
      (url) => url === largeOperationUrl,
    ).length;
    await delay(1200);
    assert.equal(
      operations.filter((url) => url === largeOperationUrl).length,
      hiddenReads,
      "hidden previews do not fetch more pages",
    );
    await page
      .getByRole("treeitem", { name: "too-large.txt", exact: true })
      .click();
    await page
      .getByText("Text previews are limited to 10 MB.", { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    results.push({
      engine,
      openMs,
      initial,
      totalBytes: limit,
      readCount,
      changedFileRejected: true,
      hiddenIdleRequests: 0,
      pageErrors: errors,
    });
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
