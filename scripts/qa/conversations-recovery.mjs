import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
const results = [];
let browser, page;
const record = (event, details) => {
  const result = { event, status: "pass", details };
  results.push(result);
  console.log(JSON.stringify(result));
};
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });
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
  const deadline = Date.now() + 90000;
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
    { timeout: 90000 },
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
  await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  const newConversation = page.getByRole("button", {
    name: "New agent conversation",
    exact: true,
  });
  const creations = [];
  let droppedCreate = false;
  await page.route("**/api/projects/*/chats", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creations.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (!droppedCreate && response.ok()) {
      droppedCreate = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await newConversation.click();
  await page
    .getByRole("region", { name: "Agent conversations", exact: true })
    .getByRole("alert")
    .waitFor();
  assert.equal(
    droppedCreate,
    true,
    "The server committed creation before its response was lost",
  );
  await newConversation.click();
  const composer = page.locator('textarea[aria-autocomplete="list"]');
  await composer.waitFor({ timeout: 30000 });
  assert.equal(creations.length, 2);
  assert.deepEqual(
    creations[1],
    creations[0],
    "Retry uses the same ID and encrypted payload",
  );
  const chatId = creations[0].id;
  const row = page.locator('[data-conversation-id="' + chatId + '"]');
  await row.waitFor();
  assert.equal(await page.locator("[data-conversation-id]").count(), 1);
  const workspace = () =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const views = (layout) =>
    layout.windows
      .flatMap((window) =>
        window.panes.flatMap((pane) => [
          ...pane.tabs,
          ...(pane.conversationView ? [pane.conversationView] : []),
        ]),
      )
      .filter((view) => view.resource.resourceId === chatId);
  assert.equal(views(await workspace()).length, 1);
  record(
    "recovery.create",
    "Committed creation with lost response retries the identical encrypted payload and opens exactly one view",
  );
  await composer.fill("Keep this draft through uncertain archive and restore");
  const lost = [];
  for (const action of ["archive", "restore"]) {
    await page.route("**/api/chats/" + chatId + "/" + action, async (route) => {
      const response = await route.fetch();
      assert.ok(response.ok(), action + " committed");
      lost.push(action);
      await route.abort("failed");
    });
  }
  await row.click({ button: "middle" });
  const archived = page.locator(
    '[data-archived-conversation-id="' + chatId + '"]',
  );
  await archived.waitFor();
  await row.waitFor({ state: "hidden" });
  await page.waitForFunction(
    async (id) =>
      (await window.__qaRepositoryFixture.workspace()).windows.every((window) =>
        window.panes.every(
          (pane) =>
            ![
              ...pane.tabs,
              ...(pane.conversationView ? [pane.conversationView] : []),
            ].some((view) => view.resource.resourceId === id),
        ),
      ),
    chatId,
  );
  await archived
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await row.waitFor();
  await archived.waitFor({ state: "hidden" });
  assert.deepEqual(lost, ["archive", "restore"]);
  assert.equal(
    views(await workspace()).length,
    0,
    "Uncertain restore reconciles without placement",
  );
  await row.click();
  await composer.waitFor();
  assert.equal(
    await composer.inputValue(),
    "Keep this draft through uncertain archive and restore",
  );
  record(
    "recovery.lifecycle",
    "Lost archive/restore responses reconcile authoritative catalogs and ownership without losing the protected draft",
  );
  let failedCatalog = 0;
  await page.route("**/api/projects/*/conversations?**", async (route) => {
    failedCatalog++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "QA catalog temporarily unavailable" }),
    });
  });
  await page.reload();
  await page
    .getByRole("region", { name: "Agent conversations", exact: true })
    .getByRole("button", { name: "Retry", exact: true })
    .waitFor({ timeout: 90000 });
  assert.ok(failedCatalog > 0);
  await composer.waitFor();
  assert.equal(
    await composer.inputValue(),
    "Keep this draft through uncertain archive and restore",
  );
  await page.unroute("**/api/projects/*/conversations?**");
  await page
    .getByRole("region", { name: "Agent conversations", exact: true })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await row.waitFor();
  assert.equal(views(await workspace()).length, 1);
  record(
    "recovery.catalog",
    "Unavailable catalogs expose Retry while the direct view and protected draft remain intact; recovery restores the row",
  );
  let forkId;
  let forkRequests = 0;
  await page.route("**/api/chats/" + chatId + "/fork", async (route) => {
    forkRequests++;
    forkId = route.request().postDataJSON().id;
    const response = await route.fetch();
    assert.ok(response.ok(), "Fork committed before losing its reply");
    await route.abort("failed");
  });
  await row
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Fork", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-conversation-id]").length === 2,
  );
  await page.locator('[data-conversation-id="' + forkId + '"]').waitFor();
  assert.equal(forkRequests, 1);
  assert.equal(
    (await workspace()).windows
      .flatMap((window) =>
        window.panes.flatMap((pane) => [
          ...pane.tabs,
          ...(pane.conversationView ? [pane.conversationView] : []),
        ]),
      )
      .filter((view) => view.resource.resourceId === forkId).length,
    0,
  );
  assert.equal(
    await composer.inputValue(),
    "Keep this draft through uncertain archive and restore",
  );
  record(
    "recovery.fork",
    "A committed fork with a lost reply reconciles to exactly one catalog resource, without a tab or a second request",
  );
  const railIds = (layout) =>
    layout.windows.flatMap((window) =>
      window.panes.flatMap((pane) => pane.tabs.map((view) => view.id)),
    );
  const originalRails = railIds(await workspace());
  const forkRow = page.locator('[data-conversation-id="' + forkId + '"]');
  await forkRow.click();
  await composer.waitFor();
  await composer.fill("A separate draft in the second direct conversation");
  await row.click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-autocomplete="list"]')?.value ===
      "Keep this draft through uncertain archive and restore",
  );
  await forkRow.click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-autocomplete="list"]')?.value ===
      "A separate draft in the second direct conversation",
  );
  assert.deepEqual(railIds(await workspace()), originalRails);
  await page.reload();
  await composer.waitFor({ timeout: 90000 });
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-autocomplete="list"]')?.value ===
      "A separate draft in the second direct conversation",
  );
  assert.equal(
    await composer.inputValue(),
    "A separate draft in the second direct conversation",
  );
  await row.click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-autocomplete="list"]')?.value ===
      "Keep this draft through uncertain archive and restore",
  );
  assert.deepEqual(railIds(await workspace()), originalRails);
  record(
    "recovery.multiple-direct",
    "Two direct conversations retain independent protected drafts across replacement and reload while file rail views remain unchanged",
  );
  await page.screenshot({
    path: path.join(fixture.directory, "conversations-recovery.png"),
    fullPage: true,
  });
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(
          fixture.directory,
          "conversations-recovery-failure.png",
        ),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(fixture.directory, "conversations-recovery-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  await fixture.close();
}
