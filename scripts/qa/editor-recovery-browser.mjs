import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const exec = promisify(execFile);
const selectedCaseIndex = process.argv.indexOf("--case");
const selectedCase =
  selectedCaseIndex < 0 ? null : process.argv[selectedCaseIndex + 1];
const selectedCases = new Set(selectedCase?.split(",") ?? []);
const seenCases = new Set();
const folderBootstrapCase = selectedCases.has("folder-bootstrap");
const modeHydrationCase = selectedCases.has("mode-hydration");
const repositoryCase =
  !selectedCase || selectedCases.has("worktree-switch-cycles");
const settingsRelease = Promise.withResolvers();
const fixture = await startEditorRecoveryFixture({
  requireExplicitBootstrapRefresh: folderBootstrapCase,
  repositoryProject: repositoryCase,
  logicalCreditControl: !selectedCase || selectedCases.has("congested-sibling"),
});
let browser;
let context;
try {
  const repository = path.join(fixture.directory, "repository");
  await mkdir(repository, { recursive: true });
  try {
    await readFile(path.join(repository, "qa.txt"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(
      path.join(repository, "qa.txt"),
      "Cantrip editor recovery baseline\n",
    );
    await writeFile(
      path.join(repository, "second.txt"),
      "Cantrip second preview file\n",
    );
    await exec("git", ["init", "--initial-branch=main", repository]);
    await exec("git", ["add", "qa.txt", "second.txt"], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=Cantrip QA",
        "-c",
        "user.email=qa@cantrip.invalid",
        "commit",
        "-m",
        "Initialize disposable recovery fixture",
      ],
      { cwd: repository },
    );
  }
  let resetRequired = false;
  const results = [];
  const errors = [];
  const observedSessions = new Map();
  const codeAttachments = new Map();
  const retiredCodeAttachments = new Set();
  const renewals = [];
  const networkTimings = [];
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const browserSockets = [];
  page.on("websocket", (socket) => browserSockets.push(socket));
  const performanceClient = await context.newCDPSession(page);
  await performanceClient.send("Performance.enable");
  await performanceClient.send("Network.enable");
  const socketStarts = new Map();
  const socketHandshakes = [];
  performanceClient.on("Network.webSocketCreated", ({ requestId, url }) => {
    socketStarts.set(requestId, { path: new URL(url).pathname });
  });
  performanceClient.on(
    "Network.webSocketWillSendHandshakeRequest",
    ({ requestId, timestamp }) => {
      const socket = socketStarts.get(requestId);
      if (socket) socket.startedAt = timestamp;
    },
  );
  performanceClient.on(
    "Network.webSocketHandshakeResponseReceived",
    ({ requestId, timestamp, response }) => {
      const socket = socketStarts.get(requestId);
      if (socket?.startedAt !== undefined && socketHandshakes.length < 256)
        socketHandshakes.push({
          path: socket.path,
          durationMs: (timestamp - socket.startedAt) * 1000,
          status: response.status,
        });
      socketStarts.delete(requestId);
    },
  );
  performanceClient.on("Network.webSocketClosed", ({ requestId }) =>
    socketStarts.delete(requestId),
  );
  page.on("requestfinished", async (request) => {
    const url = new URL(request.url());
    if (
      !url.pathname.startsWith("/__cantrip_code/") &&
      !url.pathname.includes("worker-link") &&
      !url.pathname.includes("/code/")
    )
      return;
    try {
      const timing = request.timing();
      const sizes = await request.sizes();
      if (networkTimings.length < 4096)
        networkTimings.push({
          path: url.pathname,
          method: request.method(),
          ...timing,
          responseBodyBytes: sizes.responseBodySize,
        });
    } catch {
      /* Retired requests have no complete timing observation. */
    }
  });
  await page.addInitScript(() => {
    window.__qaWorkbenchTimeline = [];
    if (window.top === window)
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (
          !message ||
          message.version !== 1 ||
          ![
            "cantrip-code.workbench-stage",
            "cantrip-code.workbench-ready",
          ].includes(message.type)
        )
          return;
        const frame = [...document.querySelectorAll("iframe")].find(
          (frame) => frame.contentWindow === event.source,
        );
        if (!frame) return;
        const url = new URL(frame.src, location.href);
        if (
          event.origin !== url.origin ||
          message.nonce !== url.searchParams.get("cantripFrameNonce")
        )
          return;
        if (window.__qaWorkbenchTimeline.length < 256)
          window.__qaWorkbenchTimeline.push({
            at: performance.timeOrigin + performance.now(),
            stage: message.stage ?? "ready",
            visible: frame.getClientRects().length > 0,
          });
      });
  });
  page.on("response", async (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.includes("/code-session-attachments")) {
      const request = response.request();
      if (response.ok() && request.method() === "DELETE")
        retiredCodeAttachments.add(pathname.split("/").at(-1));
      if (response.ok() && request.method() === "POST") {
        try {
          const { session } = await response.json();
          codeAttachments.set(session.attachmentId, {
            attachmentId: session.attachmentId,
            sessionId: session.sessionId,
            workspacePath: session.runtime.workspaceUri
              ? decodeURIComponent(
                  new URL(session.runtime.workspaceUri).pathname,
                )
              : null,
            worktreeId: request.postDataJSON().expectedWorktreeId,
          });
        } catch {
          // An aborted response cannot establish an observed attachment.
        }
      }
    }
    if (!pathname.includes("worker-link")) return;
    if (pathname.endsWith("/renew"))
      renewals.push({ pathname, status: response.status(), at: Date.now() });
    if (!response.ok() || !response.headers()["content-type"]?.includes("json"))
      return;
    try {
      const body = await response.json();
      if (body.sessionId && body.routeGeneration && body.lease)
        observedSessions.set(body.sessionId, body);
      const lease = body.lease;
      const sessionId = pathname.match(
        /\/worker-links\/([^/]+)(?:\/renew)?$/u,
      )?.[1];
      if (sessionId && observedSessions.has(sessionId) && lease?.expiresAt)
        observedSessions.get(sessionId).lease = lease;
    } catch {
      /* An aborted request supplies no verified lease observation. */
    }
  });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) =>
    errors.push({
      type: "pageerror",
      message: error.message,
      time: Date.now(),
    }),
  );
  page.on("requestfailed", (request) =>
    errors.push({
      type: "requestfailed",
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
      time: Date.now(),
    }),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push({
        type: message.type(),
        message: message.text(),
        time: Date.now(),
      });
  });
  const inject = (input) => fixture.inject(input);
  const run = async (name, operation) => {
    if (selectedCases.has(name)) {
      seenCases.add(name);
    }
    if (
      selectedCase &&
      !selectedCases.has(name) &&
      name !== "cold-editor-usable"
    )
      return;
    let started = performance.now();
    let phase = "setup";
    console.log(`QA_EVT ${JSON.stringify({ name, status: "started" })}`);
    const diagnostic = setTimeout(() => {
      void page
        .screenshot({
          path: path.join(fixture.directory, `${name}-pending.png`),
        })
        .catch(() => {});
      void page
        .locator("body")
        .ariaSnapshot()
        .then((snapshot) =>
          writeFile(
            path.join(fixture.directory, `${name}-pending.aria.txt`),
            snapshot,
          ),
        )
        .catch(() => {});
      void writeFile(
        path.join(fixture.directory, "browser-errors.json"),
        JSON.stringify(errors, null, 2),
      );
    }, 15_000);
    diagnostic.unref();
    try {
      if (
        resetRequired ||
        ["failed", "blocked"].includes(results.at(-1)?.status)
      ) {
        // Re-establish a usable fixture between independent scenarios. This is
        // outside the measured fault; the prior failure remains in the report.
        await inject({ type: "restart", process: "worker" });
        const acceptResetDialog = (dialog) => void dialog.accept();
        page.on("dialog", acceptResetDialog);
        try {
          await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
        } finally {
          page.off("dialog", acceptResetDialog);
        }
        await page
          .getByRole("treeitem", { name: "qa.txt", exact: true })
          .click();
        await waitForText("Cantrip editor recovery baseline");
        await disableAutosave();
        resetRequired = false;
        started = performance.now();
      }
      phase = "test";
      const evidence = await operation();
      results.push({
        name,
        status: "passed",
        durationMs: Math.round(performance.now() - started),
        evidence,
      });
    } catch (error) {
      results.push({
        name,
        status:
          phase === "setup" || error.name === "BlockedCaseError"
            ? "blocked"
            : "failed",
        phase,
        durationMs: Math.round(performance.now() - started),
        error: error.stack,
      });
      await page
        .screenshot({ path: path.join(fixture.directory, `${name}.png`) })
        .catch(() => {});
      await writeFile(
        path.join(fixture.directory, `${name}.aria.txt`),
        await page
          .locator("body")
          .ariaSnapshot()
          .catch(() => "snapshot unavailable"),
      );
      await writeFile(
        path.join(fixture.directory, "browser-errors.json"),
        JSON.stringify(errors, null, 2),
      );
    }
    clearTimeout(diagnostic);
    console.log(`QA_EVT ${JSON.stringify(results.at(-1))}`);
  };
  const activeEditor = () =>
    page.frameLocator("iframe:visible").locator(".monaco-editor .view-lines");
  const waitForText = async (text) => {
    await activeEditor()
      .filter({ hasText: text })
      .waitFor({ state: "visible", timeout: 90_000 });
  };
  const type = async (text) => {
    await activeEditor().click({ position: { x: 150, y: 26 } });
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
    );
    await page.keyboard.insertText(text);
    await waitForText(text);
  };
  const save = async (marker, file = path.join(repository, "qa.txt")) => {
    const deadline = Date.now() + 30_000;
    let nextAttempt = 0;
    while (Date.now() < deadline) {
      if ((await readFile(file, "utf8")).includes(marker)) return;
      if (Date.now() >= nextAttempt) {
        await page.keyboard.press(
          process.platform === "darwin" ? "Meta+s" : "Control+s",
        );
        nextAttempt = Date.now() + 1_000;
      }
      await delay(50);
    }
    throw new Error(
      `Editor save did not reach the worker-owned file: ${marker}`,
    );
  };
  const disableAutosave = async () => {
    const src = await page.locator("iframe:visible").getAttribute("src");
    const workspacePath = new URL(src, fixture.origin).searchParams.get(
      "workspace",
    );
    assert.ok(
      workspacePath?.startsWith(`${fixture.directory}${path.sep}`),
      "Only this fixture's generated workspace may be configured",
    );
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
    workspace.settings = { ...workspace.settings, "files.autoSave": "off" };
    await writeFile(workspacePath, JSON.stringify(workspace, null, 2));
    await delay(1_000);
  };
  try {
    const coldCaseName = modeHydrationCase
      ? "mode-hydration"
      : folderBootstrapCase
        ? "folder-bootstrap"
        : "cold-editor-usable";
    await run(coldCaseName, async () => {
      let settingsCaptured = false;
      let settingsHeld = false;
      let settingsDelivered = false;
      if (modeHydrationCase) {
        await page.route("**/api/settings", async (route) => {
          if (route.request().method() !== "GET" || settingsCaptured)
            return route.continue();
          settingsCaptured = true;
          const response = await route.fetch();
          settingsHeld = true;
          await settingsRelease.promise;
          await route.fulfill({ response });
          settingsDelivered = true;
        });
      }
      await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
      await page
        .getByRole("button", { name: "Save recovery file", exact: true })
        .waitFor({ timeout: 90_000 });
      const downloading = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Save recovery file", exact: true })
        .click();
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
      let modeRetries = 0;
      if (modeHydrationCase) {
        const deadline = Date.now() + 30_000;
        while (!settingsHeld && Date.now() < deadline) await delay(25);
        assert.ok(
          settingsHeld,
          "Capture the actual initial settings response before selecting IDE",
        );
        await page
          .getByRole("button", {
            name: "Chat. Switch Cantrip mode",
            exact: true,
          })
          .waitFor();
      }
      for (;;) {
        const chatMode = page.getByRole("button", {
          name: "Chat. Switch Cantrip mode",
          exact: true,
        });
        if (await chatMode.isVisible()) {
          await chatMode.click();
          await page
            .getByRole("menuitem", { name: "Cantrip IDE", exact: true })
            .click();
        }
        if (modeHydrationCase) {
          settingsRelease.resolve();
          const deadline = Date.now() + 30_000;
          while (!settingsDelivered && Date.now() < deadline) await delay(25);
          assert.ok(
            settingsDelivered,
            "Deliver the older actual settings response after the explicit choice",
          );
          await page
            .getByRole("button", {
              name: "IDE. Switch Cantrip mode",
              exact: true,
            })
            .waitFor();
        }
        try {
          await page
            .getByRole("button", { name: "Switch project", exact: true })
            .click({ timeout: 5_000 });
          if (repositoryCase) {
            await page.keyboard.press("Escape");
            break;
          }
          await page
            .locator('[data-slot="project-switcher-footer"]')
            .getByRole("button", { name: "New project", exact: true })
            .click({ timeout: 5_000 });
          break;
        } catch (error) {
          if (modeHydrationCase) throw error;
          if (modeRetries++ >= 2 || !(await chatMode.isVisible())) throw error;
        }
      }
      let setupRetries = 0;
      if (repositoryCase) {
        for (;;) {
          try {
            await page.evaluate(() => window.__qaRepositoryFixture.create());
            break;
          } catch (error) {
            if (
              setupRetries >= 3 ||
              !error.message.includes(
                "The worker's protected server connection is unavailable.",
              )
            )
              throw error;
            await delay(1_000 * ++setupRetries);
          }
        }
        const deadline = Date.now() + 30_000;
        let project;
        do {
          project = await page.evaluate(() =>
            window.__qaRepositoryFixture.project(),
          );
          if (project?.setupStatus === "ready") break;
          await delay(100);
        } while (Date.now() < deadline);
        assert.equal(
          project?.setupStatus,
          "ready",
          "The real worker direct-attachment job must finish",
        );
        assert.equal(project.capabilities.worktrees, true);
        assert.equal(project.source.path, repository);
        await page
          .getByRole("button", { name: "Switch project", exact: true })
          .click();
        await page
          .locator('[data-slot="project-switcher-project"]')
          .filter({ hasText: fixture.repositorySeed.name })
          .click();
      } else {
        await page
          .getByRole("menuitem", { name: "Folder", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Use existing", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Project name", exact: true })
          .fill("Editor Recovery QA");
        await page
          .getByPlaceholder("/path/on/the/selected/worker", { exact: true })
          .fill(repository);
        await page
          .getByRole("button", { name: "Use folder", exact: true })
          .click();
        await writeFile(
          path.join(fixture.directory, "project-submitted.aria.txt"),
          await page.locator("body").ariaSnapshot(),
        );
        // Retry the actual operation only after its specific transient failure.
        // First onboarding can precede the worker's initial protected-key refresh.
        for (; setupRetries < 3; setupRetries += 1) {
          try {
            await page
              .getByRole("treeitem", { name: "qa.txt", exact: true })
              .waitFor({ timeout: 5_000 });
            break;
          } catch (error) {
            if (
              !(await page
                .getByRole("dialog", {
                  name: "Add folder project",
                  exact: true,
                })
                .isVisible())
            )
              break;
            if (folderBootstrapCase) throw error;
            if (
              !(await page
                .getByText(
                  "The worker's protected server connection is unavailable.",
                  { exact: true },
                )
                .isVisible())
            )
              throw error;
            await delay(1_000 * (setupRetries + 1));
            await page
              .getByRole("button", { name: "Use folder", exact: true })
              .click();
          }
        }
      }
      const fileOpenStartedAt = Date.now();
      await page
        .getByRole("treeitem", { name: "qa.txt", exact: true })
        .click({ timeout: 90_000 });
      await page
        .getByRole("textbox", { name: "Edit qa.txt", exact: true })
        .waitFor({ timeout: 90_000 });
      await page
        .getByRole("button", { name: "Edit mode", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Open in VS Code", exact: true })
        .click();
      await waitForText("Cantrip editor recovery baseline");
      const fileRenderedAt = Date.now();
      await page
        .getByRole("button", { name: "Edit mode", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await disableAutosave();
      const marker = `SAVED_${Date.now()}`;
      await type(marker);
      await save(marker);
      assert.ok(
        (await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
          marker,
        ),
      );
      if (folderBootstrapCase) {
        const status = await inject({ type: "stats" });
        assert.ok(status.eventCounts["fault.bootstrap-unavailable"] > 0);
        assert.equal(status.eventCounts["fault.bootstrap-released"], 1);
        assert.equal(
          setupRetries,
          0,
          "Folder creation must succeed with one UI submission",
        );
      }
      return {
        marker,
        setupRetries,
        modeRetries,
        ...(modeHydrationCase ? { settingsHeld, settingsDelivered } : {}),
        operation: "type, save, verify worker-owned file",
        phases: {
          fileOpenStartedAt,
          fileRenderedAt,
          firstSaveVerifiedAt: Date.now(),
          fileOpenToRenderedMs: fileRenderedAt - fileOpenStartedAt,
        },
      };
    });
    await run("managed-runtimes-initialized", async () => {
      let status;
      const deadline = Date.now() + 180_000;
      do {
        status = await page.evaluate(async (workerId) => {
          const response = await fetch("/api/workers/management");
          if (!response.ok)
            throw new Error(`Worker status HTTP ${response.status}`);
          return (await response.json()).find(
            (worker) => worker.workerId === workerId,
          );
        }, fixture.workerId);
        if (
          status?.webRuntimes.search.state === "ready" &&
          status?.webRuntimes.browser.state === "ready" &&
          status?.codegraph.healthy
        )
          break;
        await delay(500);
      } while (Date.now() < deadline);
      assert.equal(
        status?.webRuntimes.search.state,
        "ready",
        JSON.stringify(status?.webRuntimes.search),
      );
      assert.equal(
        status?.webRuntimes.browser.state,
        "ready",
        JSON.stringify(status?.webRuntimes.browser),
      );
      assert.equal(
        status?.codegraph.healthy,
        true,
        JSON.stringify(status?.codegraph),
      );
      const marker = `INITIALIZED_${Date.now()}`;
      await type(marker);
      await save(marker);
      return {
        marker,
        searchVersion: status.webRuntimes.search.installedVersion,
        browserVersion: status.webRuntimes.browser.installedVersion,
        codegraphVersion: status.codegraph.installedVersion,
      };
    });
    await run("warm-close-reopen", async () => {
      const before = await page.locator("iframe:visible").getAttribute("src");
      await page
        .getByRole("button", { name: "Close file", exact: true })
        .click();
      await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
      await waitForText("Cantrip editor recovery baseline");
      assert.equal(
        await page.locator("iframe:visible").getAttribute("src"),
        before,
      );
      return { sameFrameUrl: true };
    });
    await run("carrier-dirty-buffer", async () => {
      const marker = `DIRTY_${Date.now()}`;
      await type(marker);
      await delay(1_200);
      assert.ok(
        !(await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
          marker,
        ),
        "Autosave must be off to test a dirty buffer",
      );
      const before = await page.locator("iframe:visible").getAttribute("src");
      await inject({ type: "carrier" });
      await waitForText(marker);
      await type("_RECOVERED");
      assert.equal(
        await page.locator("iframe:visible").getAttribute("src"),
        before,
      );
      assert.ok(
        !(await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
          marker,
        ),
      );
      await save(marker);
      const afterRecovery = `AFTER_RECOVERY_${Date.now()}`;
      await type(afterRecovery);
      await save(afterRecovery);
      return { sameFrameUrl: true, dirtyMarker: marker };
    });
    await run("service-worker-restart", async () => {
      const marker = `SW_${Date.now()}`;
      await type(marker);
      const fetchAsset = () =>
        page
          .frameLocator("iframe:visible")
          .locator("body")
          .evaluate(async (body) => {
            const href = body.ownerDocument.querySelector(
              'link[rel="stylesheet"]',
            )?.href;
            if (!href)
              throw new Error("The actual editor stylesheet was not found");
            const response = await fetch(href, { cache: "no-store" });
            return {
              status: response.status,
              bytes: (await response.arrayBuffer()).byteLength,
            };
          });
      // Perform a real request first, waking an idle service worker naturally.
      const before = await fetchAsset();
      assert.equal(before.status, 200);
      const client = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = await client.send("Target.getTargets");
        const target = targetInfos.find(
          (entry) =>
            entry.type === "service_worker" &&
            entry.url.startsWith(fixture.origin),
        );
        if (!target)
          throw new Error(
            "CDP did not expose this fixture's service-worker target after a real editor asset request.",
          );
        const closed = await client.send("Target.closeTarget", {
          targetId: target.targetId,
        });
        assert.equal(closed.success, true);
        const after = await fetchAsset();
        assert.deepEqual(after, before);
        await waitForText(marker);
        await save(marker);
        return {
          asset: after,
          dirtyBufferRetained: true,
          stoppedActualTarget: true,
        };
      } finally {
        await client.detach();
      }
    });
    await run("server-restart", async () => {
      const marker = `SERVER_${Date.now()}`;
      await type(marker);
      const before = await page.locator("iframe:visible").getAttribute("src");
      await inject({ type: "restart", process: "server" });
      await waitForText(marker);
      await save(marker);
      assert.equal(
        await page.locator("iframe:visible").getAttribute("src"),
        before,
      );
      return { dirtyBufferRetained: true, sameFrameUrl: true };
    });
    await run("worker-restart", async () => {
      const before = await inject({ type: "stats" });
      await inject({ type: "restart", process: "worker" });
      await waitForText("Cantrip editor recovery baseline");
      const marker = `WORKER_${Date.now()}`;
      await type(marker);
      await save(marker);
      const after = await inject({ type: "stats" });
      assert.notEqual(after.children.worker.pid, before.children.worker.pid);
      return {
        workerProcessReplaced: true,
        savedAfterFreshAuthorization: true,
      };
    });
    await run("lost-pong", async () => {
      await disableAutosave();
      const marker = `PONG_${Date.now()}`;
      await type(marker);
      await delay(1_200);
      assert.ok(
        !(await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
          marker,
        ),
      );
      const before = await inject({ type: "stats" });
      const originalDrops = before.eventCounts["fault.pong-dropped"] ?? 0;
      await inject({ type: "faults", values: { dropPong: true } });
      let drops = 0;
      try {
        const deadline = Date.now() + 70_000;
        while (Date.now() < deadline) {
          const state = await inject({ type: "stats" });
          drops =
            (state.eventCounts["fault.pong-dropped"] ?? 0) - originalDrops;
          if (drops >= 2) break;
          await delay(1_000);
        }
        assert.ok(
          drops >= 2,
          "The injected fault must actually drop Pong responses",
        );
      } finally {
        await inject({ type: "faults", values: { dropPong: false } });
      }
      await waitForText(marker);
      await save(marker);
      const after = await inject({ type: "stats" });
      assert.equal(after.children.worker.pid, before.children.worker.pid);
      return {
        droppedPongs: drops,
        workerProcessSurvived: true,
        savedAfterRecovery: true,
      };
    });
    await run("delayed-readiness", async () => {
      await page.addInitScript(() => {
        if (
          window.top !== window ||
          !new URL(location.href).searchParams.has("qaDelayReady")
        )
          return;
        const add = Window.prototype.addEventListener;
        const remove = Window.prototype.removeEventListener;
        const entries = new WeakMap();
        const readyReleaseTimes = new WeakMap();
        window.__qaReadyDelays = 0;
        Window.prototype.addEventListener = function (type, listener, options) {
          if (type !== "message" || !listener)
            return add.call(this, type, listener, options);
          const owner = this;
          const entry = { active: true, timers: new Set() };
          const call = (event) => {
            if (!entry.active) return;
            if (typeof listener === "function") listener.call(owner, event);
            else listener.handleEvent(event);
          };
          entry.wrapper = (event) => {
            if (event.data?.type !== "cantrip-code.workbench-ready")
              return call(event);
            if (!event.source) return call(event);
            let releaseAt = readyReleaseTimes.get(event.source);
            if (releaseAt === undefined) {
              releaseAt = performance.now() + 18_000;
              readyReleaseTimes.set(event.source, releaseAt);
            }
            const remaining = Math.max(0, releaseAt - performance.now());
            if (remaining === 0) return call(event);
            window.__qaReadyDelays += 1;
            const timer = setTimeout(() => {
              entry.timers.delete(timer);
              call(event);
            }, remaining);
            entry.timers.add(timer);
          };
          entries.set(listener, entry);
          return add.call(this, type, entry.wrapper, options);
        };
        Window.prototype.removeEventListener = function (
          type,
          listener,
          options,
        ) {
          const entry =
            type === "message" && listener ? entries.get(listener) : null;
          if (!entry) return remove.call(this, type, listener, options);
          entry.active = false;
          for (const timer of entry.timers) clearTimeout(timer);
          return remove.call(this, type, entry.wrapper, options);
        };
      });
      try {
        await page.goto(`${fixture.origin}/?qaDelayReady=1`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByRole("treeitem", { name: "qa.txt", exact: true })
          .click();
        await waitForText("Cantrip editor recovery baseline");
        await disableAutosave();
        const marker = `LATE_${Date.now()}`;
        await type(marker);
        await save(marker);
        const delayedMessages = await page.evaluate(
          () => window.__qaReadyDelays,
        );
        assert.ok(
          delayedMessages > 0,
          "Real readiness delivery must have been delayed",
        );
        return {
          delayedMessages,
          delayMs: 18_000,
          typedAndSavedAfterLateReady: true,
        };
      } finally {
        resetRequired = true;
      }
    });
    await run("transient-renewal", async () => {
      await disableAutosave();
      const marker = `RENEW_${Date.now()}`;
      await type(marker);
      const originalSrc = await page
        .locator("iframe:visible")
        .getAttribute("src");
      const firstRenewal = renewals.length;
      await inject({
        type: "faults",
        values: { failRenewals: 1, renewalStatus: 503 },
      });
      const deadline = Date.now() + 45_000;
      let failed;
      let successfulRetry;
      while (Date.now() < deadline) {
        const attempts = renewals.slice(firstRenewal);
        failed = attempts.find((attempt) => attempt.status === 503);
        successfulRetry =
          failed &&
          attempts.find(
            (attempt) =>
              attempt.pathname === failed.pathname &&
              attempt.status >= 200 &&
              attempt.status < 300 &&
              attempt.at >= failed.at,
          );
        if (successfulRetry) break;
        await delay(100);
      }
      assert.ok(
        failed,
        "The requested transient renewal fault must actually occur",
      );
      assert.ok(
        successfulRetry,
        "The same authority must renew successfully after the transient error",
      );
      await waitForText(marker);
      await save(marker);
      assert.equal(
        await page.locator("iframe:visible").getAttribute("src"),
        originalSrc,
      );
      return {
        failedStatus: 503,
        sameAuthorityRetried: true,
        retainedFrameAndDirtyBuffer: true,
        realLeaseMs: 45_000,
      };
    });
    const currentSessions = () =>
      [...observedSessions.values()].filter(
        (session) =>
          Date.parse(session.lease.expiresAt) > Date.now() &&
          browserSockets.some(
            (socket) =>
              !socket.isClosed() &&
              socket.url().includes(`/worker-links/${session.sessionId}/`),
          ),
      );
    const authorityRequest = (sessionId, action, data) =>
      page.request.fetch(
        `${fixture.origin}/api/worker-links/${sessionId}${action ? `/${action}` : ""}`,
        {
          method: action ? "POST" : "DELETE",
          data,
          headers: { origin: fixture.origin },
          timeout: 10_000,
        },
      );
    await run("route-replacement", async () => {
      const marker = `ROUTE_${Date.now()}`;
      await type(marker);
      const originalSrc = await page
        .locator("iframe:visible")
        .getAttribute("src");
      assert.ok(
        !(await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
          marker,
        ),
      );
      const sessions = currentSessions();
      assert.ok(
        sessions.length,
        "An actual open browser carrier must identify its session",
      );
      const replacements = [];
      for (const session of sessions) {
        const response = await authorityRequest(session.sessionId, "route", {
          preferredRoute: "relay",
        });
        assert.equal(response.status(), 200);
        const replaced = await response.json();
        assert.ok(replaced.routeGeneration > session.routeGeneration);
        replacements.push({
          generationBefore: session.routeGeneration,
          generationAfter: replaced.routeGeneration,
        });
      }
      await waitForText(marker);
      await save(marker);
      const next = `ROUTE_NEXT_${Date.now()}`;
      await type(next);
      await save(next);
      const recoveredSrc = await page
        .locator("iframe:visible")
        .getAttribute("src");
      assert.equal(
        new URL(recoveredSrc, fixture.origin).searchParams.get("workspace"),
        new URL(originalSrc, fixture.origin).searchParams.get("workspace"),
        "Recovered edits must still target the original Code workspace",
      );
      const saved = await readFile(path.join(repository, "qa.txt"), "utf8");
      assert.ok(saved.includes(marker) && saved.includes(next));
      const recoveredSessions = currentSessions();
      assert.ok(
        recoveredSessions.length,
        "Recovery must establish current carrier authority",
      );
      assert.ok(
        recoveredSessions.every((current) =>
          sessions.every(
            (previous) =>
              current.sessionId !== previous.sessionId ||
              current.routeGeneration > previous.routeGeneration,
          ),
        ),
        "Recovery must retire the replaced carrier authority",
      );
      return {
        replacements,
        savedAfterRelayReplacement: true,
        secondEditSaved: true,
        sameFrameUrl: recoveredSrc === originalSrc,
        dirtyBufferRetained: true,
        recoveredWithCurrentAuthority: true,
      };
    });
    for (const mode of ["hard-expiry", "explicit-revocation"])
      await run(mode, async () => {
        await disableAutosave();
        const marker = `AUTHORITY_${Date.now()}`;
        await type(marker);
        const sessions = currentSessions();
        assert.ok(
          sessions.length,
          "The test must exercise actual open browser carriers",
        );
        const carriers = browserSockets.filter(
          (socket) =>
            !socket.isClosed() &&
            sessions.some((session) =>
              socket.url().includes(`/worker-links/${session.sessionId}/`),
            ),
        );
        await inject({
          type: "faults",
          values: { failRenewals: 10_000, rejectSessionCreates: true },
        });
        try {
          if (mode === "explicit-revocation") {
            for (const session of sessions) {
              const response = await authorityRequest(session.sessionId);
              assert.equal(response.status(), 204);
            }
          } else {
            const expiry = Math.max(
              ...sessions.map((session) => Date.parse(session.lease.expiresAt)),
            );
            await delay(Math.max(0, expiry - Date.now()) + 1_000);
          }
          const deadline = Date.now() + 10_000;
          while (
            carriers.some((socket) => !socket.isClosed()) &&
            Date.now() < deadline
          )
            await delay(100);
          if (mode === "hard-expiry")
            assert.ok(
              carriers.every((socket) => socket.isClosed()),
              "Expired authorized carriers must close",
            );
          // Once retirement has occurred, allow the normal authenticated API
          // request through the proxy. Retired authority cannot be renewed.
          await inject({ type: "faults", values: { failRenewals: 0 } });
          for (const session of sessions) {
            const response = await authorityRequest(session.sessionId, "renew");
            assert.equal(
              response.status(),
              404,
              "The real server must reject retired authority independently of proxy faults",
            );
          }
          // Try a real save after retirement; a local rendered buffer is not proof.
          await page.keyboard.press(
            process.platform === "darwin" ? "Meta+s" : "Control+s",
          );
          await delay(2_000);
          assert.ok(
            !(await readFile(path.join(repository, "qa.txt"), "utf8")).includes(
              marker,
            ),
            "Retired authority must not write the dirty file",
          );
          return {
            closedCarriers: carriers.filter((socket) => socket.isClosed())
              .length,
            serverRejectedOldAuthority: true,
            diskUnchangedAfterSave: true,
            realLeaseMs: 45_000,
          };
        } finally {
          await inject({
            type: "faults",
            values: { failRenewals: 0, rejectSessionCreates: false },
          });
          resetRequired = true;
        }
      });
    await run("congested-sibling", async () => {
      const frame = page.frameLocator("iframe:visible");
      const asset = await frame.locator("body").evaluate((body) => {
        const entries = body.ownerDocument.defaultView.performance
          .getEntriesByType("resource")
          .filter(
            (entry) =>
              entry.name.includes("/__cantrip_code/") &&
              /\.js(?:\?|$)/u.test(entry.name),
          );
        entries.sort(
          (a, b) =>
            Number(b.name.includes("workbench.web.main")) -
              Number(a.name.includes("workbench.web.main")) ||
            b.decodedBodySize - a.decodedBodySize,
        );
        return entries[0]?.name;
      });
      assert.ok(asset, "A real loaded workbench asset is required");
      const fetchControl = () =>
        frame.locator("body").evaluate(async (_body, asset) => {
          const response = await fetch(
            `${asset}${asset.includes("?") ? "&" : "?"}qaControl=${Date.now()}`,
            { cache: "no-store" },
          );
          return {
            status: response.status,
            bytes: (await response.arrayBuffer()).byteLength,
          };
        }, asset);
      const control = await fetchControl();
      assert.equal(control.status, 200);
      const frameUrl = await page.locator("iframe:visible").getAttribute("src");
      await page.evaluate(() => window.__qaLogicalCredit.arm());
      let completed = false;
      const pending = frame.locator("body").evaluate(async (body, asset) => {
        const controller = new AbortController();
        body.ownerDocument.defaultView.__qaBulkAbort = controller;
        try {
          const response = await fetch(
            `${asset}${asset.includes("?") ? "&" : "?"}qaBulk=${Date.now()}`,
            { signal: controller.signal, cache: "no-store" },
          );
          return {
            status: response.status,
            bytes: (await response.arrayBuffer()).byteLength,
          };
        } catch (error) {
          return { error: error.name };
        }
      }, asset);
      void pending
        .finally(() => {
          completed = true;
        })
        .catch(() => {});
      const snapshot = () =>
        page.evaluate(() => window.__qaLogicalCredit.snapshot());
      const abort = () =>
        frame
          .locator("body")
          .evaluate((body) =>
            body.ownerDocument.defaultView.__qaBulkAbort?.abort(),
          );
      try {
        const deadline = Date.now() + 10_000;
        let stalled;
        do {
          stalled = await snapshot();
          if (
            stalled.withheldCredits > 0 &&
            stalled.receivedBytes === stalled.creditBytes
          )
            break;
          if (completed) break;
          await delay(50);
        } while (Date.now() < deadline);
        assert.ok(
          stalled.selected,
          "The bulk HTTP request must select its own logical connection",
        );
        assert.ok(
          stalled.withheldCredits > 0,
          "The selected connection must withhold real receive credits",
        );
        assert.ok(
          control.bytes > stalled.creditBytes,
          "The real asset must exceed the selected stream's byte window",
        );
        assert.equal(
          stalled.receivedBytes,
          stalled.creditBytes,
          "The producer must fill and stop at the actual initial credit window",
        );
        assert.equal(completed, false, "The bulk response must remain pending");
        await delay(500);
        assert.equal((await snapshot()).receivedBytes, stalled.receivedBytes);
        for (let edit = 0; edit < 2; edit += 1) {
          const marker = `SIBLING_${edit}_${Date.now()}`;
          await type(marker);
          await save(marker);
        }
        const afterSaves = await snapshot();
        assert.equal(
          completed,
          false,
          "Sibling saves must finish while the bulk producer is stalled",
        );
        assert.equal(afterSaves.receivedBytes, stalled.creditBytes);
        assert.deepEqual(
          afterSaves.currentIdentity,
          stalled.identity,
          "The original authenticated route must remain current",
        );
        assert.equal(
          await page.locator("iframe:visible").getAttribute("src"),
          frameUrl,
        );
        console.log(
          `QA_EVT ${JSON.stringify({
            name: "congested-sibling-progress",
            stage: "sibling-saves-complete",
            creditBytes: stalled.creditBytes,
            receivedBytes: afterSaves.receivedBytes,
            withheldCredits: afterSaves.withheldCredits,
            siblingEditsSaved: 2,
            originalAuthorityRetained: true,
          })}`,
        );
        await abort();
        const aborted = await pending;
        assert.equal(aborted.error, "AbortError");
        const cleanupDeadline = Date.now() + 5_000;
        let retired;
        let workerSocketClosed = false;
        do {
          retired = await snapshot();
          const workerLog = await readFile(
            path.join(fixture.directory, "worker.log"),
            "utf8",
          );
          workerSocketClosed = workerLog
            .split("\n")
            .some(
              (line) =>
                line.includes(
                  "event=tunnel.destination.remote-close-completed",
                ) &&
                Object.entries(stalled.identity).every(([key, value]) =>
                  line.includes(` ${key}=${value}`),
                ),
            );
          if (retired.retired && workerSocketClosed) break;
          await delay(50);
        } while (Date.now() < cleanupDeadline);
        assert.equal(
          retired.retired,
          true,
          "Abort must retire the actual local connection",
        );
        assert.equal(
          workerSocketClosed,
          true,
          "The worker must finish closing the TCP socket for the exact authenticated logical stream",
        );
        assert.deepEqual(retired.currentIdentity, stalled.identity);
        assert.deepEqual(
          await fetchControl(),
          control,
          "A subsequent sibling request must complete after abort",
        );
        return {
          initialCreditBytes: stalled.creditBytes,
          stalledResponseBytes: afterSaves.receivedBytes,
          withheldCredits: afterSaves.withheldCredits,
          controlResponseBytes: control.bytes,
          siblingEditsSaved: 2,
          originalAuthorityRetained: true,
          sameFrameUrl: true,
          abortedLocally: retired.retired,
          workerSocketClosed,
        };
      } finally {
        await abort().catch(() => {});
        await Promise.race([pending.catch(() => {}), delay(5_000)]);
        await page.evaluate(() => window.__qaLogicalCredit.release());
      }
    });
    await run("worktree-switch-cycles", async () => {
      const primary = (
        await page.evaluate(() => window.__qaRepositoryFixture.worktrees())
      ).find((worktree) => worktree.isPrimary);
      assert.ok(primary, "The real repository import must create Primary");
      assert.equal(primary.path, repository);
      const worktrees = [primary];
      for (const suffix of ["alpha", "beta"]) {
        worktrees.push(
          await page.evaluate(
            (input) => window.__qaRepositoryFixture.createWorktree(input),
            {
              name: `QA ${suffix}`,
              sourceWorktreeId: primary.id,
              mode: {
                type: "newBranch",
                branch: `qa-${suffix}`,
                startPoint: "HEAD",
              },
            },
          ),
        );
      }
      assert.equal(new Set(worktrees.map(({ id }) => id)).size, 3);
      assert.equal(new Set(worktrees.map(({ path }) => path)).size, 3);
      for (const worktree of worktrees) {
        assert.equal(worktree.workerId, fixture.workerId);
        assert.equal(worktree.lifecycleState, "ready");
        assert.ok(
          worktree.path.startsWith(`${fixture.directory}${path.sep}`),
          "Every checkout must belong to this disposable fixture",
        );
        const { stdout } = await exec("git", [
          "-C",
          worktree.path,
          "rev-parse",
          "--show-toplevel",
        ]);
        assert.equal(stdout.trim(), worktree.path);
      }
      // The normal live events refresh the UI's worktree queries.
      let current = primary;
      const switches = [];
      for (const next of [
        worktrees[1],
        worktrees[2],
        primary,
        worktrees[2],
        worktrees[1],
        primary,
      ]) {
        const beforeFrame = await page
          .locator("iframe:visible")
          .elementHandle();
        const oldWorkspace = new URL(
          await beforeFrame.getAttribute("src"),
          fixture.origin,
        ).searchParams.get("workspace");
        const oldAttachments = [...codeAttachments.values()].filter(
          ({ worktreeId, workspacePath, attachmentId }) =>
            worktreeId === current.id &&
            workspacePath === oldWorkspace &&
            !retiredCodeAttachments.has(attachmentId),
        );
        assert.ok(
          oldAttachments.length,
          "Observe the active authorized attachment before switching",
        );
        const beforeFiles = new Map(
          await Promise.all(
            worktrees.map(async (worktree) => [
              worktree.id,
              await readFile(path.join(worktree.path, "qa.txt"), "utf8"),
            ]),
          ),
        );
        await page
          .getByRole("button", { name: current.name, exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: next.name, exact: true })
          .click();
        await page
          .getByRole("button", { name: next.name, exact: true })
          .waitFor();
        await page
          .getByRole("treeitem", { name: "qa.txt", exact: true })
          .click();
        await waitForText("Cantrip editor recovery baseline");
        const src = await page.locator("iframe:visible").getAttribute("src");
        const workspacePath = new URL(src, fixture.origin).searchParams.get(
          "workspace",
        );
        assert.ok(workspacePath?.startsWith(`${fixture.directory}${path.sep}`));
        const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
        assert.deepEqual(
          workspace.folders.map(({ path }) => path),
          [next.path],
        );
        await disableAutosave();
        for (let edit = 0; edit < 2; edit += 1) {
          const marker = `WORKTREE_${switches.length}_${edit}_${Date.now()}`;
          await type(marker);
          await save(marker, path.join(next.path, "qa.txt"));
        }
        for (const sibling of worktrees.filter(({ id }) => id !== next.id))
          assert.equal(
            await readFile(path.join(sibling.path, "qa.txt"), "utf8"),
            beforeFiles.get(sibling.id),
            `Saving ${next.name} must not change ${sibling.name}`,
          );
        const retirementDeadline = Date.now() + 10_000;
        while (
          Date.now() < retirementDeadline &&
          ((await beforeFrame.evaluate((frame) => frame.isConnected)) ||
            oldAttachments.some(
              ({ attachmentId }) => !retiredCodeAttachments.has(attachmentId),
            ))
        )
          await delay(50);
        assert.equal(
          await beforeFrame.evaluate((frame) => frame.isConnected),
          false,
          "The previous worktree iframe must be removed",
        );
        assert.ok(
          oldAttachments.every(({ attachmentId }) =>
            retiredCodeAttachments.has(attachmentId),
          ),
          `The server must acknowledge release of the outgoing workspace attachment: ${JSON.stringify(oldAttachments.map(({ attachmentId }) => ({ attachmentId, released: retiredCodeAttachments.has(attachmentId) })))}`,
        );
        assert.ok(
          [...codeAttachments.values()].some(
            ({ worktreeId, workspacePath: observedWorkspace, attachmentId }) =>
              worktreeId === next.id &&
              observedWorkspace === workspacePath &&
              !retiredCodeAttachments.has(attachmentId),
          ),
          "The new editor must have its own current authorized attachment",
        );
        await beforeFrame.dispose();
        switches.push({
          from: current.name,
          to: next.name,
          editsSaved: 2,
          oldFrameRemoved: true,
          releasedAttachments: oldAttachments.length,
        });
        console.log(
          `QA_EVT ${JSON.stringify({ name: "worktree-switch", ...switches.at(-1) })}`,
        );
        current = next;
      }
      return {
        relayBytesPerMinute: 1024 ** 3,
        worktrees: worktrees.map(({ name, path: checkout }) => ({
          name,
          path: path.relative(fixture.directory, checkout),
        })),
        switches,
      };
    });
    await run("preview-pin-cycles", async () => {
      for (let cycle = 0; cycle < 5; cycle += 1) {
        await page
          .getByRole("treeitem", { name: "second.txt", exact: true })
          .click();
        await waitForText("Cantrip second preview file");
        await page
          .getByRole("treeitem", { name: "qa.txt", exact: true })
          .dblclick();
        await waitForText("Cantrip editor recovery baseline");
        const marker = `PIN_${cycle}_${Date.now()}`;
        await type(marker);
        await save(marker);
      }
      return { cycles: 5, iframeCount: await page.locator("iframe").count() };
    });
    await page.screenshot({
      path: path.join(fixture.directory, "browser-final.png"),
    });
  } finally {
    settingsRelease.resolve();
    const workbenchTimeline = await page
      .evaluate(() => window.__qaWorkbenchTimeline ?? [])
      .catch(() => []);
    const rendererMetrics = await performanceClient
      .send("Performance.getMetrics")
      .catch(() => ({ metrics: [] }));
    // Retained heap and an unconstrained GC-cycle snapshot answer different
    // questions. Collect both after the timed behavior has completed.
    const garbageCollected = await performanceClient
      .send("HeapProfiler.collectGarbage")
      .then(
        () => true,
        () => false,
      );
    const retainedRendererMetrics = garbageCollected
      ? await performanceClient
          .send("Performance.getMetrics")
          .catch(() => ({ metrics: [] }))
      : { metrics: [] };
    await writeFile(
      path.join(fixture.directory, "browser-metrics.json"),
      JSON.stringify(
        {
          workbenchTimeline,
          networkTimings,
          socketHandshakes,
          rendererMetrics: rendererMetrics.metrics.filter((metric) =>
            [
              "JSHeapUsedSize",
              "JSHeapTotalSize",
              "Documents",
              "Nodes",
            ].includes(metric.name),
          ),
          garbageCollected,
          retainedRendererMetrics: retainedRendererMetrics.metrics.filter(
            (metric) =>
              [
                "JSHeapUsedSize",
                "JSHeapTotalSize",
                "Documents",
                "Nodes",
              ].includes(metric.name),
          ),
        },
        null,
        2,
      ),
    );
    await performanceClient.detach().catch(() => {});
    const runtimesAtShutdown = await page
      .evaluate(async (workerId) => {
        const response = await fetch("/api/workers/management");
        if (!response.ok)
          throw new Error(`Worker status HTTP ${response.status}`);
        const worker = (await response.json()).find(
          (entry) => entry.workerId === workerId,
        );
        return {
          search: worker?.webRuntimes.search.state,
          browser: worker?.webRuntimes.browser.state,
          codegraph: worker?.codegraph.runtimeState,
        };
      }, fixture.workerId)
      .catch((error) => ({ unavailable: error.message }));
    try {
      await context.close();
      await browser.close();
    } finally {
      await fixture.close();
      const shutdowns = fixture.events.filter(
        (event) => event.type === "process.stopped" && event.name === "worker",
      );
      const exited = fixture.events.filter(
        (event) => event.type === "process.exit" && event.name === "worker",
      );
      const passed =
        shutdowns.length > 0 &&
        exited.length === shutdowns.length &&
        shutdowns.every(
          (event) =>
            event.code === 0 &&
            event.signal === null &&
            !event.snapshotError &&
            event.survivors.length === 0,
        ) &&
        exited.every((event) => event.code === 0 && event.signal === null);
      results.push({
        name: "worker-shutdown",
        status: passed ? "passed" : "failed",
        evidence: { runtimesAtShutdown, shutdowns, exited },
      });
      console.log(`QA_EVT ${JSON.stringify(results.at(-1))}`);
      await writeFile(
        path.join(fixture.directory, "browser-results.json"),
        JSON.stringify({ origin: fixture.origin, results, errors }, null, 2),
      );
    }
  }
  if (results.some((result) => result.status === "failed"))
    process.exitCode = 1;
  else if (results.some((result) => result.status === "blocked"))
    process.exitCode = 2;
  else if (
    selectedCase &&
    [...selectedCases].some((name) => !seenCases.has(name))
  ) {
    console.error(`Unknown browser case: ${selectedCase}`);
    process.exitCode = 2;
  }
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await fixture.close();
}
