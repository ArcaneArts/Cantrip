import assert from "node:assert/strict";
import { mkdir, appendFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const output = path.resolve("test-results/log-file-follow");
await mkdir(output, { recursive: true });
const limit = 12 * 1024 * 1024;
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
      "SENTINEL-daemon.log",
    );
    await writeFile(file, content);
    await writeFile(
      path.join(fixture.repositorySeed.repository, "too-large.txt"),
      "a".repeat(limit + 1),
    );
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 850 },
      colorScheme: engine === "chromium" ? "dark" : "light",
    });
    const page = await context.newPage();
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
      .getByRole("treeitem", { name: "SENTINEL-daemon.log", exact: true })
      .waitFor({ timeout: 90_000 });
    const started = performance.now();
    await page
      .getByRole("treeitem", { name: "SENTINEL-daemon.log", exact: true })
      .click();
    const viewer = page.locator("[data-log-file-view]:visible");
    const input = viewer.getByRole("textbox", {
      name: "View SENTINEL-daemon.log",
      exact: true,
    });
    await input.waitFor({ timeout: 30_000 });
    const openMs = performance.now() - started;
    const atBottom = () =>
      input.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 2,
      );
    await page.waitForFunction(() => {
      const node = document.querySelector("[data-log-file-view] textarea");
      return (
        node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2
      );
    });
    assert.equal(await input.evaluate((node) => node.readOnly), true);
    assert.ok(
      (await input.inputValue()).endsWith("SENTINEL_FINAL_PREVIEW_LINE"),
    );
    assert.ok(
      (await input.inputValue()).length <= 256 * 1024,
      "starts with a bounded tail, including logs above 10 MiB",
    );
    assert.ok((await viewer.locator("[data-editor-line]").count()) < 100);
    const tailUrl = operations[0];
    const reads = () => operations.filter((url) => url === tailUrl).length;
    await appendFile(file, "\nSENTINEL_APPENDED_A\n");
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.endsWith("SENTINEL_APPENDED_A\n"),
    );
    assert.equal(await atBottom(), true);
    await page.screenshot({
      path: path.join(output, `${engine}-following.png`),
    });
    await input.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await viewer.getByRole("status").filter({ hasText: "Paused" }).waitFor();
    const pausedReads = reads();
    await appendFile(file, "SENTINEL_WHILE_PAUSED\n");
    await delay(1600);
    assert.equal(reads(), pausedReads, "scrolling up stops tail reads");
    assert.ok(!(await input.inputValue()).includes("SENTINEL_WHILE_PAUSED"));
    assert.equal(await input.evaluate((node) => node.scrollTop), 0);
    await page.screenshot({ path: path.join(output, `${engine}-paused.png`) });
    await input.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await viewer.getByRole("status").filter({ hasText: "Following" }).waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.includes("SENTINEL_WHILE_PAUSED"),
    );
    assert.equal(await atBottom(), true);
    await viewer
      .getByRole("button", { name: "Pause following", exact: true })
      .click();
    const buttonPaused = reads();
    await appendFile(file, "SENTINEL_BUTTON_PAUSED\n");
    await delay(1400);
    assert.equal(reads(), buttonPaused);
    await viewer
      .getByRole("button", { name: "Follow log", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.includes("SENTINEL_BUTTON_PAUSED"),
    );
    await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Edit qa.txt", exact: true })
      .waitFor();
    const hiddenReads = reads();
    await appendFile(file, "SENTINEL_WHILE_HIDDEN\n");
    await delay(1600);
    assert.equal(reads(), hiddenReads, "hidden panels stop tail reads");
    await page
      .getByRole("treeitem", { name: "SENTINEL-daemon.log", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.includes("SENTINEL_WHILE_HIDDEN"),
    );
    assert.equal(await atBottom(), true);
    // Rotation and copy/truncate should replace the old tail, not concatenate files.
    await rename(file, file + ".1");
    await writeFile(file, "SENTINEL_ROTATED\n".repeat(100));
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.startsWith("SENTINEL_ROTATED"),
    );
    assert.ok(!(await input.inputValue()).includes("SENTINEL_WHILE_HIDDEN"));
    await writeFile(file, "SENTINEL_TRUNCATED\n");
    await page.waitForFunction(
      () =>
        document.querySelector("[data-log-file-view] textarea")?.value ===
        "SENTINEL_TRUNCATED\n",
    );
    assert.equal(await atBottom(), true);
    // Browser backgrounding also retires polling; foregrounding catches up.
    await page.evaluate(() => {
      window.__qaLogVisibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => window.__qaLogVisibility,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const backgroundReads = reads();
    await appendFile(file, "SENTINEL_BACKGROUND\n");
    await delay(1500);
    assert.equal(reads(), backgroundReads);
    await page.evaluate(() => {
      window.__qaLogVisibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() =>
      document
        .querySelector("[data-log-file-view] textarea")
        ?.value.includes("SENTINEL_BACKGROUND"),
    );
    const controls = page.getByRole("toolbar", {
      name: "File controls",
      exact: true,
    });
    await controls
      .getByRole("button", { name: "View mode", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Edit SENTINEL-daemon.log", exact: true })
      .waitFor();
    await controls
      .getByRole("button", { name: "Edit mode", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "View", exact: true }).click();
    await input.waitFor();
    assert.deepEqual(errors, []);
    results.push({
      engine,
      openMs,
      initialSize: limit,
      scrollPause: true,
      scrollResume: true,
      buttonControl: true,
      hiddenReads: 0,
      backgroundReads: 0,
      rotation: true,
      truncation: true,
      editMode: true,
      errors,
    });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
await writeFile(
  path.join(output, "results.json"),
  JSON.stringify(results, null, 2),
);
