import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
import { isEditorReloadTeardownError } from "./editor-reload-error.mjs";

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
  const runtimeErrors = [];
  const reloadNetworkErrors = [];
  let reloadingRenderer = false;
  const results = [],
    errors = [],
    requests = [],
    codeCreations = [];
  const usedLegacyEditor = () =>
    requests.some((url) =>
      /monaco|editor\.api|code-attachments|code-session|\/code-tabs\/[^/]+\/(?:protected-attachment|sessions)/u.test(
        url,
      ),
    );
  const usedCode = () => usedLegacyEditor() || codeCreations.length > 0;
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
    await context.addInitScript(() => {
      for (const type of ["error", "unhandledrejection"]) {
        window.addEventListener(type, (event) => {
          const error = type === "error" ? event.error : event.reason;
          console.debug(
            "QA_RUNTIME_ERROR",
            JSON.stringify({
              type,
              message: String(error?.message ?? error ?? event.message),
              stack: error?.stack,
            }),
          );
        });
      }
    });
    context.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      requests.push(pathname);
      if (
        request.method() === "POST" &&
        /\/api\/projects\/[^/]+\/code-tabs$/u.test(pathname)
      )
        codeCreations.push(pathname);
    });
    page = await context.newPage();
    page.on("pageerror", (error) => {
      // WebKit reports a caught fetch started by pagehide cleanup as a
      // javascript console/page error. Limit this classification to the actual
      // deliberate reload and same-origin teardown/signaling endpoints.
      if (
        isEditorReloadTeardownError({
          browser: name,
          reloadingRenderer,
          origin: fixture.origin,
          message: error.message,
        })
      )
        reloadNetworkErrors.push(error.message);
      else errors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
      if (message.text().startsWith("QA_RUNTIME_ERROR "))
        runtimeErrors.push(
          JSON.parse(message.text().slice("QA_RUNTIME_ERROR ".length)),
        );
    });
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
    assert.equal(usedCode(), false);
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
    // Observe actual recovery completion, then destroy this renderer. This is
    // distinct from server/worker restart tests that keep the in-memory draft.
    await input.evaluate((node) => {
      node.setSelectionRange(3, 8, "backward");
      node.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await page
      .locator('[data-document-recovery="ready"]')
      .filter({ has: input })
      .waitFor();
    const beforeReload = await input.inputValue();
    reloadingRenderer = true;
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
    } finally {
      reloadingRenderer = false;
    }
    await input.waitFor({ timeout: 30000 });
    assert.equal(await input.inputValue(), beforeReload);
    assert.deepEqual(
      await input.evaluate((node) => [
        node.selectionStart,
        node.selectionEnd,
        node.selectionDirection,
      ]),
      [3, 8, "backward"],
    );
    await input.press("ControlOrMeta+z");
    assert.notEqual(await input.inputValue(), beforeReload);
    await input.press("ControlOrMeta+Shift+z");
    assert.equal(await input.inputValue(), beforeReload);
    assert.equal(
      (await readFile(file, "utf8")).includes("unsaved native marker"),
      false,
    );
    record("native.renderer-reload-draft", { status: "pass" });
    for (const processName of ["server", "worker"]) {
      const marker =
        processName === "server"
          ? "unsaved native marker"
          : "worker restart draft";
      if (processName === "worker")
        await input.pressSequentially(`\n${marker}\n`);
      const retainedDraft = await input.inputValue();
      const restartAt = Date.now();
      await fixture.inject({ type: "restart", process: processName });
      assert.equal(await input.inputValue(), retainedDraft);
      await input.press("ControlOrMeta+s");
      let saveAttempts = 1;
      const firstSaveSucceeded = await saveOutcome(marker);
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
          throw new Error(
            "The actual worker command connection did not recover",
          );
        await delay(50);
      }
      if (!firstSaveSucceeded) {
        await page
          .getByRole("button", { name: "Reload from disk", exact: true })
          .waitFor();
        assert.equal(await input.inputValue(), retainedDraft);
        await page
          .getByRole("button", { name: "Save file", exact: true })
          .click();
        saveAttempts++;
      }
      const deadline = Date.now() + 15000;
      while (
        !(await readFile(file, "utf8")).includes(marker) &&
        Date.now() < deadline
      )
        await delay(50);
      assert.ok((await readFile(file, "utf8")).includes(marker));
      await page
        .getByRole("button", { name: "File is saved", exact: true })
        .waitFor();
      record(`native.${processName}-restart`, { status: "pass", saveAttempts });
      await saveMarker(`\npost-${processName}-restart second edit\n`);
    }
    const createdWorktree = await page.evaluate(() =>
      window.__qaRepositoryFixture.createWorktree({
        name: "native-editor-alternate",
        mode: {
          type: "newBranch",
          branch: "qa/native-editor-alternate",
          startPoint: "HEAD",
        },
      }),
    );
    await page.waitForFunction(
      async (id) =>
        (await window.__qaRepositoryFixture.worktrees()).some(
          (worktree) =>
            worktree.id === id && worktree.lifecycleState === "ready",
        ),
      createdWorktree.id,
      { timeout: 30000 },
    );
    const alternate = await page.evaluate(
      async (id) =>
        (await window.__qaRepositoryFixture.worktrees()).find(
          (worktree) => worktree.id === id,
        ),
      createdWorktree.id,
    );
    const primaryBeforeAlternateSave = await readFile(file, "utf8");
    const alternatePage = await context.newPage();
    const alternateSearch = await page.evaluate(
      (id) => window.__qaRepositoryFixture.popout("qa.txt", id),
      alternate.id,
    );
    await alternatePage.goto(`${fixture.origin}/${alternateSearch}`, {
      waitUntil: "domcontentloaded",
    });
    const alternateInput = alternatePage.getByRole("textbox", {
      name: "Edit qa.txt",
      exact: true,
    });
    await alternateInput.waitFor();
    assert.equal(
      await alternateInput.inputValue(),
      "Cantrip editor recovery baseline\n",
    );
    await alternateInput.fill("alternate worktree native save\n");
    await alternateInput.press("ControlOrMeta+s");
    const alternateDeadline = Date.now() + 15000;
    while (
      (await readFile(path.join(alternate.path, "qa.txt"), "utf8")) !==
      "alternate worktree native save\n"
    ) {
      if (Date.now() > alternateDeadline)
        throw new Error("The alternate worktree file was not saved");
      await delay(50);
    }
    assert.equal(await readFile(file, "utf8"), primaryBeforeAlternateSave);
    assert.equal(await alternatePage.locator("iframe").count(), 0);
    await alternatePage.close();
    await page.evaluate(() => window.__qaRepositoryFixture.closePopouts());
    record("native.alternate-worktree", { status: "pass" });
    const chat = await page.evaluate(() =>
      window.__qaRepositoryFixture.createChat(),
    );
    const chatFile = path.join(
      fixture.directory,
      "worker",
      "chat-scratch",
      chat.id,
      "notes.cantrip-source",
    );
    const provisionDeadline = Date.now() + 30000;
    for (;;) {
      try {
        await writeFile(chatFile, "Chat editor baseline\n");
        break;
      } catch (error) {
        // Retry an actual missing directory while the real provision job runs.
        // Never create the worker-owned scratch directory or registry ourselves.
        if (error.code !== "ENOENT" || Date.now() > provisionDeadline)
          throw error;
        await delay(50);
      }
    }
    const chatPage = await context.newPage();
    chatPage.on("pageerror", (error) => errors.push(error.message));
    const chatSearch = await page.evaluate(
      (id) =>
        window.__qaRepositoryFixture.chatFileSearch(id, "notes.cantrip-source"),
      chat.id,
    );
    await chatPage.goto(`${fixture.origin}/${chatSearch}`, {
      waitUntil: "domcontentloaded",
    });
    const chatInput = chatPage.getByRole("textbox", {
      name: "Edit notes.cantrip-source",
      exact: true,
    });
    try {
      await chatInput.waitFor({ timeout: 30000 });
      assert.equal(await chatInput.inputValue(), "Chat editor baseline\n");
      await chatInput.fill("Chat native saved 😀é\n");
      await chatInput.press("ControlOrMeta+s");
      const chatSaveDeadline = Date.now() + 15000;
      while ((await readFile(chatFile, "utf8")) !== "Chat native saved 😀é\n") {
        if (Date.now() > chatSaveDeadline)
          throw new Error("Chat native save did not reach the scratch file");
        await delay(50);
      }
      assert.equal(await chatPage.locator("iframe").count(), 0);
      await chatPage.screenshot({
        path: path.join(fixture.directory, "native-chat-file.png"),
      });
      record("native.chat-file", { status: "pass" });
    } catch (error) {
      await writeFile(
        path.join(fixture.directory, "native-chat-failed.aria.txt"),
        await chatPage
          .locator("body")
          .ariaSnapshot({ timeout: 5000 })
          .catch(() => ""),
      );
      await chatPage
        .screenshot({
          path: path.join(fixture.directory, "native-chat-failed.png"),
          timeout: 5000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await chatPage.close();
    }
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
    assert.equal(
      usedCode(),
      false,
      "Ordinary file routes across every window must not create Code tabs/attachments or load Monaco",
    );
    await page.screenshot({
      path: path.join(fixture.directory, "native-editor.png"),
    });
    const nativeTabFile = path.join(
      fixture.repositorySeed.repository,
      "native-tab.ts",
    );
    await writeFile(nativeTabFile, "export const nativeTab = true;\n");
    if (mobile) {
      await page
        .getByRole("button", { name: "Choose project tab", exact: true })
        .click();
      await page.getByRole("button", { name: "Code", exact: true }).click();
    } else {
      await page
        .getByRole("button", { name: "Add project surface", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Code", exact: true }).click();
    }
    await page
      .getByRole("tree", { name: "Project files", exact: true })
      .getByRole("treeitem", { name: /^native-tab\.ts .*B$/u })
      .click();
    const nativeTabInput = page.getByRole("textbox", {
      name: "Edit native-tab.ts",
      exact: true,
    });
    await nativeTabInput.waitFor();
    assert.equal(
      await nativeTabInput.inputValue(),
      "export const nativeTab = true;\n",
    );
    const nativeTabText = "export const nativeTab = 'saved 😀';\n";
    await nativeTabInput.fill(nativeTabText);
    await nativeTabInput.press("ControlOrMeta+s");
    const nativeTabSaveDeadline = Date.now() + 15000;
    while ((await readFile(nativeTabFile, "utf8")) !== nativeTabText) {
      if (Date.now() > nativeTabSaveDeadline)
        throw new Error("Native Code tab save did not reach the worker file");
      await delay(50);
    }
    await page.getByRole("button", { name: "Edit mode", exact: true }).click();
    await page.getByRole("menuitem", { name: "View", exact: true }).click();
    const nativeTabViewer = page.getByRole("textbox", {
      name: "View native-tab.ts",
      exact: true,
    });
    await nativeTabViewer.waitFor();
    assert.equal(await nativeTabViewer.inputValue(), nativeTabText);
    assert.deepEqual(
      await nativeTabViewer.evaluate((node) => ({
        readOnly: node.readOnly,
        caret: getComputedStyle(node).caretColor,
      })),
      { readOnly: true, caret: "rgba(0, 0, 0, 0)" },
    );
    await nativeTabViewer.press("x");
    await nativeTabViewer.press("Backspace");
    await nativeTabViewer.press("ControlOrMeta+s");
    assert.equal(await nativeTabViewer.inputValue(), nativeTabText);
    assert.equal(await readFile(nativeTabFile, "utf8"), nativeTabText);
    assert.equal(codeCreations.length, 1);
    assert.equal(usedLegacyEditor(), false);
    assert.equal(await page.locator("iframe").count(), 0);
    await page.screenshot({
      path: path.join(fixture.directory, "native-code-tab.png"),
    });
    record("native.code-tab", { status: "pass" });
    const revokedWindow = await context.newPage();
    const revokedSearch = await page.evaluate(() =>
      window.__qaRepositoryFixture.popout("second.txt"),
    );
    await revokedWindow.goto(`${fixture.origin}/${revokedSearch}`, {
      waitUntil: "domcontentloaded",
    });
    const revokedInput = revokedWindow.getByRole("textbox", {
      name: "Edit second.txt",
      exact: true,
    });
    await revokedInput.waitFor();
    await revokedInput.fill("private draft from the retired account");
    const beforeRevocation = await readFile(
      path.join(fixture.repositorySeed.repository, "second.txt"),
      "utf8",
    );
    await page.evaluate(() => window.__qaRepositoryFixture.revokeOwner());
    await revokedWindow
      .getByText(
        "The editor's account changed. Reopen this file from Cantrip.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await revokedInput.inputValue(),
      "private draft from the retired account",
    );
    await revokedInput.press("ControlOrMeta+s");
    await revokedWindow
      .getByText("The editor window is closed.", { exact: true })
      .waitFor();
    assert.equal(
      await revokedInput.inputValue(),
      "private draft from the retired account",
    );
    assert.equal(
      await readFile(
        path.join(fixture.repositorySeed.repository, "second.txt"),
        "utf8",
      ),
      beforeRevocation,
    );
    await revokedWindow.close();
    record("native.account-revocation", { status: "pass" });
    assert.deepEqual(runtimeErrors, []);
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
        {
          results,
          errors,
          consoleErrors,
          runtimeErrors,
          reloadNetworkErrors,
          networkTimings,
          resourcePaths: [...new Set(requests)],
          codeCreations,
        },
        null,
        2,
      ),
    );
    await browser?.close();
    await fixture.close();
  }
}
