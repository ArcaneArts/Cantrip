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
  await page.getByRole("tab", { name: "Chats", exact: true }).click();
  const previousRows = await page.locator("[data-conversation-id]").count();
  await page
    .getByRole("button", { name: "New agent chat", exact: true })
    .click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("[data-conversation-id]").length > count,
    previousRows,
  );
  const row = page.locator("[data-conversation-id]").first();
  await row.waitFor();
  const chatId = await row.getAttribute("data-conversation-id");
  const workspace = () =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const locate = (layout) =>
    layout.windows.flatMap((window) =>
      window.panes.flatMap((pane) =>
        [
          ...pane.tabs,
          ...(pane.conversationView ? [pane.conversationView] : []),
        ]
          .filter((view) => view.resource.resourceId === chatId)
          .map((view) => ({ pane, view })),
      ),
    );
  await page.waitForFunction(
    async (id) =>
      (await window.__qaRepositoryFixture.workspace()).windows.some((window) =>
        window.panes.some(
          (pane) => pane.conversationView?.resource.resourceId === id,
        ),
      ),
    chatId,
  );
  let direct = locate(await workspace())[0];
  assert.equal(direct.pane.conversationView.id, direct.view.id);
  record("direct-create", "Created an Agent through + without a rail tab");
  const composer = page.locator('textarea[aria-autocomplete="list"]');
  await composer.fill("Keep this unsent placement draft");
  for (const region of ["right", "bottom", "center"]) {
    const target =
      region === "center"
        ? page
            .getByRole("tablist", { name: "Project pane tabs", exact: true })
            .first()
        : page.locator(`[data-dock-rail="${region}"]`);
    const start = await row.boundingBox();
    const end = await target.boundingBox();
    assert.ok(start && end, `Visible ${region} destination`);
    await page.mouse.move(start.x + 25, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + start.height / 2, {
      steps: 4,
    });
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
      steps: 20,
    });
    await page.mouse.up();
    await page.waitForFunction(
      async ({ chatId, region }) =>
        (await window.__qaRepositoryFixture.workspace()).windows.some(
          (window) =>
            window.panes.some(
              (pane) =>
                pane.region === region &&
                pane.tabs.some((tab) => tab.resource.resourceId === chatId),
            ),
        ),
      { chatId, region },
    );
    const matches = locate(await workspace());
    assert.equal(matches.length, 1);
    assert.equal(matches[0].view.id, direct.view.id);
    assert.equal(await row.count(), 1);
    assert.equal(
      await composer.inputValue(),
      "Keep this unsent placement draft",
    );
    record(
      `drag-${region}`,
      "Real pointer drag preserves one view identity, its catalog row, and unsent draft",
    );
    const railTab =
      region === "center"
        ? page.locator(`[data-project-tab-key="${direct.view.id}"]`)
        : page.locator(`[data-dock-rail-tab="${direct.view.id}"]`);
    await railTab.click({ button: "middle" });
    await page.waitForFunction(
      async (id) =>
        !(await window.__qaRepositoryFixture.workspace()).windows.some(
          (window) =>
            window.panes.some((pane) =>
              [
                ...pane.tabs,
                ...(pane.conversationView ? [pane.conversationView] : []),
              ].some((view) => view.resource.resourceId === id),
            ),
        ),
      chatId,
    );
    assert.equal(await row.count(), 1);
    assert.equal(
      await page.locator(`[data-archived-conversation-id="${chatId}"]`).count(),
      0,
    );
    record(
      `close-${region}`,
      "Rail middle-click removes only the view and keeps the active catalog conversation",
    );
    await row.click();
    await page.waitForFunction(
      async (id) =>
        (await window.__qaRepositoryFixture.workspace()).windows.some(
          (window) =>
            window.panes.some(
              (pane) => pane.conversationView?.resource.resourceId === id,
            ),
        ),
      chatId,
    );
    direct = locate(await workspace())[0];
    assert.equal(
      await composer.inputValue(),
      "Keep this unsent placement draft",
    );
  }
  await row.click({ button: "middle" });
  const archived = page.locator(`[data-archived-conversation-id="${chatId}"]`);
  await archived.waitFor();
  assert.equal(locate(await workspace()).length, 0);
  await archived.click();
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await page.locator(`[data-conversation-id="${chatId}"]`).waitFor();
  assert.equal(locate(await workspace()).length, 0);
  record(
    "archive-restore",
    "Sidebar middle-click archives a draft-only chat; Restore creates no view",
  );
  await page.locator(`[data-conversation-id="${chatId}"]`).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Keep this unsent placement draft");
  assert.equal(
    await composer.getAttribute("placeholder"),
    "Queue a prompt while paused…",
  );
  record(
    "restored-draft",
    "Restored direct conversation retains its unsent draft",
  );
  await page.screenshot({
    path: path.join(fixture.directory, "conversations-placement.png"),
    fullPage: true,
  });
} catch (error) {
  if (page) {
    await page
      .screenshot({
        path: path.join(
          fixture.directory,
          "conversations-placement-failure.png",
        ),
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      path.join(fixture.directory, "conversations-placement-failure.html"),
      await page.content(),
    ).catch(() => {});
  }
  console.error("QA failure artifacts:", fixture.directory);
  throw error;
} finally {
  await writeFile(
    path.join(fixture.directory, "conversations-placement-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  await fixture.close();
}
