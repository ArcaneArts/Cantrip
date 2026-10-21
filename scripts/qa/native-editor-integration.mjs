import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const cases = [
  ["chromium", chromium, false],
  ["chromium", chromium, true],
  ["webkit", webkit, false],
  ["webkit", webkit, true],
];
const selected = cases.filter(
  ([name, , mobile]) =>
    process.argv.includes("--all") ||
    (name === (process.argv.includes("--webkit") ? "webkit" : "chromium") &&
      mobile === process.argv.includes("--phone")),
);
for (const [name, engine, mobile] of selected) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser, page;
  const networkTimings = [];
  const consoleErrors = [];
  const results = [],
    errors = [],
    requests = [];
  const record = (event, details = {}) => {
    const entry = {
      event,
      browser: name,
      viewport: mobile ? "phone" : "desktop",
      ...details,
    };
    results.push(entry);
    const { requests: timings, ...summary } = entry;
    console.log(
      `QA_EVT ${JSON.stringify({ ...summary, ...(timings ? { requestCount: timings.length } : {}) })}`,
    );
  };
  try {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 800 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) =>
      requests.push(new URL(request.url()).pathname),
    );
    page.on("requestfinished", (request) => {
      const timing = request.timing();
      if (new URL(request.url()).pathname.startsWith("/api/"))
        networkTimings.push({
          path: new URL(request.url()).pathname,
          method: request.method(),
          start: timing.startTime,
          duration: timing.responseEnd,
        });
    });
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    record("native.bootstrap", {
      phase: "initial-page",
      state: await page.evaluate(() => ({
        secure: window.isSecureContext,
        children: document.getElementById("root")?.childElementCount,
        title: document.title,
      })),
    });
    const recovery = page.getByRole("button", {
      name: "Save recovery file",
      exact: true,
    });
    await recovery.waitFor({ timeout: 90000 });
    const downloading = page.waitForEvent("download");
    await recovery.click();
    await (
      await downloading
    ).saveAs(path.join(fixture.directory, "disposable-recovery.json"));
    await page
      .getByRole("checkbox", {
        name: "I saved the recovery file somewhere I can access later.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Continue to Cantrip", exact: true })
      .click();
    // Attempt the actual protected operation. Only its specific startup error retries.
    const admissionDeadline = Date.now() + 90_000;
    for (let attempt = 0; ; attempt++) {
      try {
        await page.evaluate(() => window.__qaRepositoryFixture.create());
        break;
      } catch (error) {
        if (
          Date.now() >= admissionDeadline ||
          !error.message.includes("protected server connection is unavailable")
        )
          throw error;
        await delay(Math.min(1000 * (attempt + 1), 3000));
      }
    }
    await page.waitForFunction(
      async () =>
        (await window.__qaRepositoryFixture.project())?.setupStatus === "ready",
      { timeout: 30000 },
    );
    const chatMode = page.getByRole("button", {
      name: "Chat. Switch Cantrip mode",
      exact: true,
    });
    if (mobile) {
      await page
        .getByRole("button", { name: "Switch to IDE", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .waitFor();
    } else {
      await chatMode.waitFor();
      await chatMode.click();
      await page
        .getByRole("menuitem", { name: "Cantrip IDE", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Switch project", exact: true })
        .waitFor();
    }
    if (mobile) {
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Switch project", exact: true })
        .click();
      await page
        .locator('[data-slot="project-switcher-project"]')
        .filter({ hasText: fixture.repositorySeed.name })
        .click();
    }
    const started = performance.now();
    const fileOpenAt = Date.now();
    await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
    const input = page.getByRole("textbox", {
      name: "Edit qa.txt",
      exact: true,
    });
    await input.waitFor({ timeout: 30000 });
    record("native.open", {
      milliseconds: performance.now() - started,
      requests: networkTimings.filter((request) => request.start >= fileOpenAt),
    });
    assert.equal(await page.locator("iframe").count(), 0);
    assert.equal(
      requests.some((url) =>
        /monaco|editor\.api|code-attachments|code-session/u.test(url),
      ),
      false,
    );
    const file = path.join(fixture.repositorySeed.repository, "qa.txt");
    const saveOutcome = async (marker) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if ((await readFile(file, "utf8")).includes(marker)) return true;
        if (
          await page
            .getByRole("button", { name: "Reload from disk", exact: true })
            .isVisible()
        )
          return false;
        await delay(50);
      }
      throw new Error(
        "The actual save produced neither a disk write nor a visible failure",
      );
    };
    const saveMarker = async (marker) => {
      await input.focus();
      await input.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
      await input.pressSequentially(marker);
      await input.press("ControlOrMeta+s");
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if ((await readFile(file, "utf8")).includes(marker)) {
          await page
            .getByRole("button", { name: "File is saved", exact: true })
            .waitFor();
          return;
        }
        await delay(50);
      }
      throw new Error(`Actual worker file did not receive ${marker}`);
    };
    await saveMarker("\nnative initial save\n");
    record("native.save", { status: "pass" });
    const openFile = async (name) => {
      if (mobile)
        await page
          .getByRole("button", { name: "Open sidebar", exact: true })
          .click();
      await page.getByRole("treeitem", { name, exact: true }).click();
    };
    await openFile("unknown.cantrip-source");
    const unknownInput = page.getByRole("textbox", {
      name: "Edit unknown.cantrip-source",
      exact: true,
    });
    await unknownInput.waitFor();
    assert.equal(await unknownInput.inputValue(), "first\nsecond\n");
    await unknownInput.fill("first\nchanged\n");
    await unknownInput.press("ControlOrMeta+s");
    const unknownFile = path.join(
      fixture.repositorySeed.repository,
      "unknown.cantrip-source",
    );
    const expectedBytes = Buffer.from("\uFEFFfirst\r\nchanged\r\n");
    const unknownDeadline = Date.now() + 15000;
    while (!(await readFile(unknownFile)).equals(expectedBytes)) {
      if (Date.now() > unknownDeadline)
        throw new Error(
          "Unknown-file save did not preserve BOM and CRLF bytes",
        );
      await delay(50);
    }
    record("native.unknown-file-bom-crlf", { status: "pass" });
    await page
      .getByRole("button", { name: "File is saved", exact: true })
      .waitFor();
    await openFile("qa.txt");
    await input.waitFor();
    if (!mobile) {
      const popout = await context.newPage();
      const stalePopout = await context.newPage();
      for (const child of [popout, stalePopout]) {
        child.on("pageerror", (error) => errors.push(error.message));
        child.on("console", (message) => {
          if (message.type() === "error")
            consoleErrors.push(`file-window: ${message.text()}`);
        });
        const search = await page.evaluate(() =>
          window.__qaRepositoryFixture.popout("second.txt"),
        );
        await child.goto(`${fixture.origin}/${search}`, {
          waitUntil: "domcontentloaded",
        });
        await child
          .getByRole("textbox", { name: "Edit second.txt", exact: true })
          .waitFor();
        assert.equal(await child.locator("iframe").count(), 0);
      }
      const childInput = popout.getByRole("textbox", {
        name: "Edit second.txt",
        exact: true,
      });
      await childInput.fill("native file window saved\n");
      await childInput.press("ControlOrMeta+s");
      const secondFile = path.join(
        fixture.repositorySeed.repository,
        "second.txt",
      );
      const deadline = Date.now() + 15000;
      while (
        !(await readFile(secondFile, "utf8")).includes(
          "native file window saved",
        )
      ) {
        if (Date.now() > deadline)
          throw new Error("File-window save did not reach its worker file");
        await delay(50);
      }
      if (process.argv.includes("--vscode")) {
        await popout
          .getByRole("button", { name: "Open in VS Code", exact: true })
          .click();
        const codeLines = popout
          .frameLocator("iframe:visible")
          .locator(".monaco-editor .view-lines")
          .filter({ hasText: "native file window saved" });
        let retries = 0;
        await (async () => {
          for (;;) {
            const outcome = await Promise.race([
              codeLines.waitFor({ timeout: 90000 }).then(
                () => "ready",
                () => "timeout",
              ),
              popout
                .getByRole("button", { name: "Retry", exact: true })
                .waitFor({ timeout: 90000 })
                .then(
                  () => "retry",
                  () => "timeout",
                ),
            ]);
            if (outcome === "ready") return;
            if (outcome !== "retry" || retries >= 2)
              throw new Error(
                "The explicit VS Code window did not render its actual file",
              );
            // Retry only a visible failure from the real operation, using the
            // existing product control rather than readiness metadata.
            retries++;
            record("native.vscode-window-retry", { attempt: retries });
            await delay(1000);
            await popout
              .getByRole("button", { name: "Retry", exact: true })
              .click();
          }
        })().catch(async (error) => {
          await writeFile(
            path.join(fixture.directory, "vscode-file-window-failed.aria.txt"),
            await popout
              .locator("body")
              .ariaSnapshot({ timeout: 5000 })
              .catch(() => ""),
          );
          await popout
            .screenshot({
              path: path.join(
                fixture.directory,
                "vscode-file-window-failed.png",
              ),
              timeout: 5000,
            })
            .catch(() => {});
          throw error;
        });
        record("native.explicit-vscode-window", { status: "pass", retries });
      }
      const staleInput = stalePopout.getByRole("textbox", {
        name: "Edit second.txt",
        exact: true,
      });
      await staleInput.fill("independent window draft");
      await staleInput.press("ControlOrMeta+s");
      await stalePopout
        .getByText(/changed.*(?:disk|externally)|modified|conflict/iu)
        .first()
        .waitFor();
      assert.equal(await staleInput.inputValue(), "independent window draft");
      assert.equal(
        await readFile(secondFile, "utf8"),
        "native file window saved\n",
      );
      await stalePopout.screenshot({
        path: path.join(fixture.directory, "native-file-window.png"),
      });
      await popout.close();
      await stalePopout.close();
      await page.evaluate(() => window.__qaRepositoryFixture.closePopouts());
      record("native.file-windows", { status: "pass" });
    }
    if (!mobile) {
      await page
        .getByRole("treeitem", { name: "qa.txt", exact: true })
        .dblclick();
      await page.getByRole("tab", { name: /qa\.txt/u }).waitFor();
    }
    await input.pressSequentially("unsaved native marker 😀é");
    const draft = await input.inputValue();
    await input.evaluate((node) => {
      node.setSelectionRange(3, 8, "backward");
      node.dispatchEvent(new Event("select", { bubbles: true }));
    });
    if (mobile) {
      await page
        .getByRole("button", { name: "Edit mode", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "View", exact: true }).click();
      await page
        .getByRole("button", { name: "View mode", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    } else {
      await page
        .getByRole("treeitem", { name: "second.txt", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Edit second.txt", exact: true })
        .waitFor();
      await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
    }
    await input.waitFor();
    assert.equal(await input.inputValue(), draft);
    assert.deepEqual(
      await input.evaluate((node) => [
        node.selectionStart,
        node.selectionEnd,
        node.selectionDirection,
      ]),
      [3, 8, "backward"],
    );
    await input.press("ControlOrMeta+z");
    assert.notEqual(await input.inputValue(), draft);
    await input.press("ControlOrMeta+Shift+z");
    assert.equal(await input.inputValue(), draft);
    record(mobile ? "native.mode-continuity" : "native.tab-continuity", {
      status: "pass",
    });
    const restartAt = Date.now();
    await fixture.inject({ type: "restart", process: "server" });
    assert.equal(await input.inputValue(), draft);
    await input.press("ControlOrMeta+s");
    let saveAttempts = 1;
    const firstSaveSucceeded = await saveOutcome("unsaved native marker");
    const connectionDeadline = Date.now() + 30000;
    while (
      !fixture.events.some(
        (event) =>
          event.type === "socket.open" &&
          event.path?.startsWith("/api/internal/workers/connect") &&
          Date.parse(event.timestamp) > restartAt,
      )
    ) {
      if (Date.now() > connectionDeadline)
        throw new Error("The actual worker command connection did not recover");
      await delay(50);
    }
    if (!firstSaveSucceeded) {
      await page
        .getByRole("button", { name: "Reload from disk", exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), draft);
      await page
        .getByRole("button", { name: "Save file", exact: true })
        .click();
      saveAttempts++;
    }
    const deadline = Date.now() + 15000;
    while (
      !(await readFile(file, "utf8")).includes("unsaved native marker") &&
      Date.now() < deadline
    )
      await delay(50);
    assert.match(await readFile(file, "utf8"), /unsaved native marker/u);
    record("native.server-restart", { status: "pass", saveAttempts });
    await saveMarker("\npost-restart second edit\n");
    await input.pressSequentially("conflicting draft");
    const conflictDraft = await input.inputValue();
    await writeFile(file, "external edit\n");
    await input.press("ControlOrMeta+s");
    await page
      .getByText(/changed.*(?:disk|externally)|modified|conflict/iu)
      .first()
      .waitFor({ timeout: 15000 });
    assert.equal(await input.inputValue(), conflictDraft);
    assert.equal(await readFile(file, "utf8"), "external edit\n");
    record("native.conflict", { status: "pass" });
    await page.screenshot({
      path: path.join(fixture.directory, "native-editor.png"),
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    record("native.failed", {
      error: error.message,
      directory: fixture.directory,
      errors,
      consoleErrors,
    });
    await page
      ?.screenshot({
        path: path.join(fixture.directory, "native-editor-failed.png"),
        timeout: 5000,
      })
      .catch(() => {});
    if (page)
      await writeFile(
        path.join(fixture.directory, "native-editor-failed.aria.txt"),
        await page
          .locator("body")
          .ariaSnapshot({ timeout: 5000 })
          .catch(() => ""),
      );
    throw error;
  } finally {
    await writeFile(
      path.join(fixture.directory, "native-editor-results.json"),
      JSON.stringify(
        { results, errors, consoleErrors, networkTimings },
        null,
        2,
      ),
    );
    await browser?.close();
    await fixture.close();
  }
}
