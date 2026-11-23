import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { isEditorReloadTeardownError } from "./editor-reload-error.mjs";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const engine = process.argv[2] ?? "chromium";
const browserType = { chromium, webkit }[engine];
if (!browserType) throw new Error("Expected chromium or webkit");
const evidence = path.resolve(
  process.env.CANTRIP_QA_EVIDENCE ?? "/tmp/cantrip-alerts-evidence",
);
await mkdir(evidence, { recursive: true });
const results = [],
  teardownErrors = [],
  errors = [],
  requests = [];
let fixture, browser, page;
let reloadingRenderer = false;
async function reload() {
  reloadingRenderer = true;
  try {
    await page.reload();
    await alerts(page).waitFor();
  } finally {
    reloadingRenderer = false;
  }
}
const record = (event, details) => {
  const value = { event, status: "pass", details, context: { engine } };
  results.push(value);
  console.log(`QA_EVT ${JSON.stringify(value)}`);
};
async function until(fn, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out: ${description}${error ? ": " + error.message : ""}`,
  );
}
const alerts = (p) =>
  p.getByRole("region", { name: "Alert Inbox", exact: true });
const tile = (p) => p.locator('[data-slot="project-alert-tile"]');
const action = (p, input) =>
  p.evaluate((v) => window.__qaAlerts.control(v), input);
const list = (p, id) => p.evaluate((id) => window.__qaAlerts.list(id), id);
const noAlert = async (p) => {
  await alerts(p).getByText("No active alerts", { exact: true }).waitFor();
  assert.equal(await tile(p).count(), 0);
};
async function openProject(p, name) {
  await p.getByRole("button", { name: "Switch project", exact: true }).click();
  await p
    .locator('[data-slot="project-switcher-project"]')
    .filter({ hasText: name })
    .click();
}
async function expand(p, id) {
  const row = p.locator(`[data-alert-id="${id}"]`);
  await row.waitFor();
  const button = row.getByRole("button").first();
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  return row;
}
try {
  fixture = await startEditorRecoveryFixture({
    repositoryProject: true,
    projectAlerts: true,
  });
  browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });
  context.on("page", (p) =>
    p.on("pageerror", (e) => {
      if (
        isEditorReloadTeardownError({
          browser: engine,
          reloadingRenderer,
          origin: fixture.origin,
          message: e.message,
        })
      )
        teardownErrors.push(e.message);
      else errors.push(e.message);
    }),
  );
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("request", (r) =>
    requests.push({
      method: r.method(),
      path: new URL(r.url()).pathname,
      body: r.postData(),
    }),
  );
  await page.goto(fixture.origin);
  const save = page.getByRole("button", {
    name: "Save recovery file",
    exact: true,
  });
  await save.waitFor({ timeout: 90000 });
  const download = page.waitForEvent("download");
  await save.click();
  await (
    await download
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
  await until(
    async () => {
      try {
        return await page.evaluate(() => window.__qaRepositoryFixture.create());
      } catch (e) {
        if (!e.message.includes("protected server connection is unavailable"))
          throw e;
        return false;
      }
    },
    "encrypted project creation",
    90000,
  );
  await until(
    () =>
      page.evaluate(
        async () =>
          (await window.__qaRepositoryFixture.project())?.setupStatus ===
          "ready",
      ),
    "project setup",
    90000,
  );
  const first = await page.evaluate(() =>
    window.__qaRepositoryFixture.project(),
  );
  const background = await page.evaluate(() =>
    window.__qaAlerts.backgroundProject(),
  );
  await until(
    () =>
      page.evaluate(async () => {
        const p = await window.__qaAlerts.control({ op: "stats" });
        return p.executions.length === 0;
      }),
    "fixture ready",
  );
  const chat = await until(
    () =>
      page.evaluate(async (id) => {
        try {
          return await window.__qaAlerts.chat(id, "Background builder");
        } catch (e) {
          if (!String(e).includes("No online worker")) throw e;
          return false;
        }
      }, background.id),
    "background Chat placement",
    90000,
  );
  await page.evaluate((id) => window.__qaAlerts.prepare(id), chat.id);
  await page
    .getByRole("button", { name: "Chat. Switch Cantrip mode", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Cantrip IDE", exact: true })
    .click();
  await openProject(page, fixture.repositorySeed.name);
  assert.equal(await tile(page).count(), 0);
  const request = await page.evaluate(
    (id) => window.__qaAlerts.interaction(id),
    chat.id,
  );
  await page
    .getByRole("button", { name: "Switch project", exact: true })
    .click();
  const entry = page
    .locator('[data-slot="project-switcher-project"]')
    .filter({ hasText: "Alerts-Background-QA" });
  await entry
    .locator('[data-slot="project-alert-count"][aria-label="1 Alert"]')
    .waitFor();
  record(
    "background-count",
    "A Chat never opened in this client produces a nonzero project-switcher badge while a different project is selected.",
  );
  await entry.click();
  await until(async () => {
    if (await alerts(page).count()) return true;
    const button = tile(page).filter({ hasText: "1 Alert" });
    if ((await button.count()) && (await button.isEnabled()))
      await button.click();
    return (await alerts(page).count()) > 0;
  }, "Inbox navigation after project attachment");
  const permission = (await list(page, background.id)).items.find(
    (a) => a.sourceId === request.id,
  );
  const row = await expand(page, permission.id);
  await row
    .getByText("QA private change requires your decision", { exact: true })
    .waitFor();
  assert.equal((await action(page, { op: "stats" })).executions.length, 0);
  await page.screenshot({
    path: path.join(evidence, `${engine}-permission.png`),
  });
  record(
    "protected-request-context",
    "Inbox renders the actual encrypted request and decisions; opening it executes nothing.",
  );
  await action(page, { op: "fail-replies", enabled: true });
  await row.getByRole("button", { name: "Allow once", exact: true }).click();
  await row
    .getByRole("alert")
    .filter({ hasText: "Injected QA reply rejection" })
    .waitFor();
  assert.equal((await list(page, background.id)).items.length, 1);
  await action(page, { op: "fail-replies", enabled: false });
  await row.getByRole("button", { name: "Deny", exact: true }).click();
  await noAlert(page);
  record(
    "failed-then-denied",
    "A real HTTP rejection preserves the alert; a successful encrypted Deny retires it and hides the tile without closing the Inbox.",
  );

  const older = await page.evaluate(
    (id) => window.__qaAlerts.interaction(id),
    chat.id,
  );
  const input = await page.evaluate(
    (id) => window.__qaAlerts.interaction(id, "userInput"),
    chat.id,
  );
  await until(
    async () => (await tile(page).textContent()) === "2 Alerts",
    "independent request count",
  );
  let items = (await list(page, background.id)).items;
  const inputRow = await expand(
    page,
    items.find((a) => a.sourceId === input.id).id,
  );
  await inputRow
    .getByRole("radio", { name: "Staging Disposable test" })
    .check();
  await inputRow
    .getByRole("button", { name: "Open chat", exact: true })
    .click();
  await page
    .locator('[data-interaction-request-id="' + input.id + '"]')
    .waitFor();
  await page
    .locator("[data-project-tab-key]")
    .filter({ hasText: "Alert Inbox" })
    .getByRole("tab", { name: "Alert Inbox", exact: true })
    .click();
  const reopened = await expand(
    page,
    items.find((a) => a.sourceId === input.id).id,
  );
  await reopened
    .getByRole("radio", { name: "Staging Disposable test" })
    .check();
  await reopened
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await until(
    async () => (await tile(page).textContent()) === "1 Alert",
    "one request remains",
  );
  assert.equal((await list(page, background.id)).items[0].sourceId, older.id);
  record(
    "independent-input",
    "Answering one request leaves the older independent permission actionable.",
  );

  const stable = (await list(page, background.id)).items[0];
  await page.evaluate(
    ({ id, key }) => window.__qaAlerts.interaction(id, "fileChange", key),
    { id: chat.id, key: older.requestKey },
  );
  assert.equal((await list(page, background.id)).items.length, 1);
  await fixture.inject({ type: "carrier", path: "/api/live" });
  await reload();
  await alerts(page).waitFor();
  assert.equal((await list(page, background.id)).items[0].id, stable.id);
  record(
    "reconnect-dedup",
    "Duplicate source delivery, live carrier interruption and page reload preserve one exact alert.",
  );
  await (
    await expand(page, stable.id)
  )
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await noAlert(page);

  await page.evaluate((id) => window.__qaAlerts.prepare(id), chat.id);
  const agent = await page.evaluate(
    (id) => window.__qaAlerts.agent(id),
    chat.id,
  );
  await until(
    async () => (await tile(page).textContent()) === "1 Alert",
    "agent alert count",
  );
  const agentRow = await expand(page, agent.id);
  await agentRow
    .getByText("QA agent needs a decision", { exact: true })
    .last()
    .waitFor();
  await agentRow
    .getByText("Agent: Background builder", { exact: false })
    .waitFor();
  await agentRow
    .getByText("Provide disposable credentials in the originating chat.", {
      exact: true,
    })
    .waitFor();
  const wire = JSON.stringify(await list(page, background.id));
  assert.ok(!wire.includes("QA private blocker"));
  await page.evaluate(
    ({ id, key }) => window.__qaAlerts.agent(id, key, 2, "resolved"),
    { id: chat.id, key: agent.episodeId },
  );
  await noAlert(page);
  record(
    "agent-attribution",
    "Scoped AI alert displays its named agent, protected explanation and next step; resolution removes it.",
  );
  await page.evaluate((id) => window.__qaAlerts.prepare(id), chat.id);
  await page.evaluate(
    (id) => window.__qaAlerts.goal(id, "usageLimited", 1),
    chat.id,
  );
  const goal = (await list(page, background.id)).items[0];
  await (
    await expand(page, goal.id)
  )
    .getByText("QA private Goal objective", { exact: true })
    .waitFor();
  await page.evaluate((id) => window.__qaAlerts.goal(id, "active", 2), chat.id);
  await noAlert(page);
  record(
    "goal-stall",
    "An actual protected Goal observation with exhausted usage is visible, and an active observation retires that episode.",
  );

  const task = await page.evaluate(
    (id) => window.__qaAlerts.chat(id, "Review task"),
    background.id,
  );
  await page.evaluate((id) => window.__qaAlerts.task(id), task.id);
  await reload();
  await alerts(page).waitFor();
  const taskAlert = (await list(page, background.id)).items.find(
    (a) => a.chatId === task.id,
  );
  const review = await expand(page, taskAlert.id);
  await review.getByText("Which QA target?", { exact: true }).waitFor();
  await review.getByRole("radio", { name: /Staging/ }).check();
  await review.getByText("Answers saved", { exact: true }).waitFor();
  await review
    .getByText("Review the plan and choose whether to begin implementation.", {
      exact: true,
    })
    .waitFor();
  record(
    "task-answers",
    "The real Task plan review saves an encrypted answer and presents the next implementation decision in the same Inbox episode.",
  );
  await page.evaluate(
    (id) => window.__qaAlerts.task(id, "implementing", false),
    task.id,
  );
  await noAlert(page);

  for (const reason of ["archive", "stop", "delete"]) {
    const c = await page.evaluate(
      ({ id, reason }) => window.__qaAlerts.chat(id, "Retire " + reason),
      { id: background.id, reason },
    );
    await page.evaluate((id) => window.__qaAlerts.prepare(id, false), c.id);
    await page.evaluate((id) => window.__qaAlerts.interaction(id), c.id);
    await until(
      async () => (await list(page, background.id)).items.length === 1,
      "retirement source visible",
    );
    await action(page, { op: "retire", chatId: c.id, reason });
    await noAlert(page);
  }
  record(
    "retirement",
    "Archive, explicit stop and deletion each retire current source alerts.",
  );

  const concurrent = await page.evaluate(
    (id) => window.__qaAlerts.interaction(id),
    chat.id,
  );
  const concurrentAlert = (await list(page, background.id)).items[0];
  // Browser hosts reject desktop-only windows without transferring ownership.
  await page
    .locator("[data-project-tab-key]")
    .filter({ hasText: "Alert Inbox" })
    .getByRole("button", { name: "Actions for Alert Inbox", exact: true })
    .click();
  assert.equal(
    await page.getByRole("menuitem", { name: "Pop Out", exact: true }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  await alerts(page).waitFor();
  record(
    "browser-popout-boundary",
    "The browser omits desktop-only popout actions and preserves the owned Inbox.",
  );
  const concurrentRow = await expand(page, concurrentAlert.id);
  const responseWire = await page.evaluate(
    (id) => window.__qaAlerts.responseWire(id),
    concurrent.id,
  );
  const peer = await context.newPage();
  await peer.route("**/qa-alert-response", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>QA second responder</title>",
    }),
  );
  await peer.goto(fixture.origin + "/qa-alert-response");
  const before = (await action(page, { op: "stats" })).executions.length;
  const responses = await Promise.allSettled([
    concurrentRow
      .getByRole("button", { name: "Allow once", exact: true })
      .click(),
    peer.evaluate(
      async ({ id, wire }) => {
        const result = await fetch("/api/agent-requests/" + id + "/respond", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(wire.csrf ? { "x-cantrip-csrf": wire.csrf } : {}),
          },
          body: JSON.stringify(wire.body),
        });
        if (!result.ok) throw new Error("Concurrent response " + result.status);
        return result.json();
      },
      { id: concurrent.id, wire: responseWire },
    ),
  ]);
  assert.ok(responses.some((r) => r.status === "fulfilled"));
  await noAlert(page);
  assert.equal(
    (await action(page, { op: "stats" })).executions.length - before,
    1,
    "One accepted native request identity",
  );
  await peer.close();
  record(
    "concurrent-windows",
    "Two authorized browser windows submit encrypted answers for one request; the projection settles to zero with one accepted native request identity.",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await reload();
  await alerts(page).waitFor();
  await page.screenshot({ path: path.join(evidence, `${engine}-compact.png`) });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  assert.equal(overflow, false, "No page-wide compact overflow");
  record(
    "compact-layout",
    "Inbox remains usable in a compact viewport without page-wide horizontal overflow.",
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
  for (const r of requests)
    if (r.body && !r.path.startsWith("/api/__qa/")) {
      assert.ok(
        !r.body.includes("QA private question") &&
          !r.body.includes("QA private blocker") &&
          !r.body.includes("QA private task"),
        "Sensitive content stays encrypted in normal HTTP bodies",
      );
    }
  const serverLog = await readFile(
    path.join(fixture.directory, "server.log"),
    "utf8",
  );
  assert.ok(
    !serverLog.includes("QA private blocker") &&
      !serverLog.includes("QA private question"),
  );
  record(
    "privacy-runtime",
    "No page errors or protected explanation/question plaintext in normal API bodies or server logs.",
  );
} catch (error) {
  results.push({
    event: "browser-failure",
    status: "fail",
    details: error.stack,
    context: { engine, fixture: fixture?.directory },
  });
  console.error(`QA_EVT ${JSON.stringify(results.at(-1))}`);
  if (page)
    await page
      .screenshot({ path: path.join(evidence, `${engine}-failure.png`) })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await fixture?.close();
  await writeFile(
    path.join(evidence, `${engine}-results.json`),
    JSON.stringify(
      { results, errors, teardownErrors, fixture: fixture?.directory },
      null,
      2,
    ),
  );
}
