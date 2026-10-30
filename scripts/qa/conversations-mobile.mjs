import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
const results = [];
let browser, page, mobile;
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
  const desktopBefore = await page.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  const project = await page.evaluate(() =>
    window.__qaRepositoryFixture.project(),
  );
  mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await mobile.addInitScript(
    (id) => sessionStorage.setItem("__qaRepositoryProjectId", id),
    project.id,
  );
  await mobile.goto(fixture.origin);
  await mobile
    .getByRole("button", { name: "Import recovery file", exact: true })
    .waitFor({ timeout: 90000 });
  await mobile
    .locator("input[type=file]")
    .setInputFiles(path.join(fixture.directory, "disposable-recovery.json"));
  const openSidebar = async () => {
    await mobile
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click({ timeout: 90000 });
    await mobile.getByRole("tab", { name: "Conversations", exact: true }).tap();
  };
  // A fresh installation may render its shell before restoring the selected
  // project. Select the fixture project through the drawer before using it.
  await mobile
    .getByRole("button", { name: "Open sidebar", exact: true })
    .tap({ timeout: 90000 });
  await mobile
    .getByRole("button", { name: "Switch project", exact: true })
    .tap();
  await mobile
    .locator('[data-slot="project-switcher-project"]')
    .filter({ hasText: fixture.repositorySeed.name })
    .tap();
  await openSidebar();
  await mobile
    .getByRole("button", { name: "New agent conversation", exact: true })
    .tap();
  const composer = mobile.locator('textarea[aria-autocomplete="list"]');
  await composer.waitFor({ state: "visible", timeout: 30000 });
  await composer.fill("Mobile direct draft survives hiding and reload");
  const workspace = () =>
    mobile.evaluate(() => window.__qaRepositoryFixture.workspace());
  const views = (layout) =>
    layout.windows.flatMap((window) =>
      window.panes.flatMap((pane) => [
        ...pane.tabs,
        ...(pane.conversationView ? [pane.conversationView] : []),
      ]),
    );
  const tabs = (layout) =>
    layout.windows.flatMap((window) =>
      window.panes.flatMap((pane) => pane.tabs),
    );
  const direct = views(await workspace()).find(
    (view) => view.resource.definitionId === "project.agent",
  );
  assert.ok(direct);
  const chatId = direct.resource.resourceId;
  assert.equal(tabs(await workspace()).length, 0);
  assert.notEqual((await workspace()).id, desktopBefore.id);
  record("mobile.direct", { chatId, railTabs: 0 });
  await openSidebar();
  const row = mobile.locator('[data-conversation-id="' + chatId + '"]');
  await row.tap();
  await composer.waitFor({ state: "visible" });
  assert.equal(
    await composer.inputValue(),
    "Mobile direct draft survives hiding and reload",
  );
  await mobile.reload();
  await composer.waitFor({ state: "visible", timeout: 90000 });
  assert.equal(
    await composer.inputValue(),
    "Mobile direct draft survives hiding and reload",
  );
  assert.equal(tabs(await workspace()).length, 0);
  record(
    "mobile.reload",
    "Direct conversation and protected draft restored without a rail tab",
  );
  for (const [name, region] of [
    ["Place in right rail", "right"],
    ["Place in bottom rail", "bottom"],
    ["Place in top rail", "center"],
  ]) {
    await openSidebar();
    await row
      .locator("..")
      .getByRole("button", { name: /Actions for/ })
      .tap();
    await mobile.getByRole("menuitem", { name, exact: true }).tap();
    await composer.waitFor({ state: "visible" });
    await mobile.waitForFunction(
      async ({ chatId, region }) =>
        (await window.__qaRepositoryFixture.workspace()).windows.some(
          (window) =>
            window.panes.some(
              (pane) =>
                pane.region === region &&
                pane.tabs.some((view) => view.resource.resourceId === chatId),
            ),
        ),
      { chatId, region },
    );
    assert.equal(
      views(await workspace()).filter(
        (view) => view.resource.resourceId === chatId,
      ).length,
      1,
    );
    assert.equal(
      await composer.inputValue(),
      "Mobile direct draft survives hiding and reload",
    );
  }
  record(
    "mobile.placement",
    "Touch menus place the same view in each rail and keep it usable",
  );
  await openSidebar();
  await row
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .tap();
  await mobile.getByRole("menuitem", { name: "Archive", exact: true }).tap();
  const archived = mobile.locator(
    '[data-archived-conversation-id="' + chatId + '"]',
  );
  await archived.waitFor();
  assert.equal(
    views(await workspace()).filter(
      (view) => view.resource.resourceId === chatId,
    ).length,
    0,
  );
  await archived
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .tap();
  await mobile.getByRole("menuitem", { name: "Restore", exact: true }).tap();
  await row.waitFor();
  assert.equal(
    views(await workspace()).filter(
      (view) => view.resource.resourceId === chatId,
    ).length,
    0,
  );
  await row.tap();
  await composer.waitFor({ state: "visible" });
  assert.equal(
    await composer.inputValue(),
    "Mobile direct draft survives hiding and reload",
  );
  record(
    "mobile.restore",
    "Touch archive and restore preserve the draft; restore creates no placement",
  );
  await openSidebar();
  await row
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .tap();
  await mobile.getByRole("menuitem", { name: "Archive", exact: true }).tap();
  await archived.waitFor();
  await archived
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .tap();
  await mobile
    .getByRole("menuitem", { name: "Permanently Delete", exact: true })
    .tap();
  const dialog = mobile.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
  await archived.waitFor();
  await archived
    .locator("..")
    .getByRole("button", { name: /Actions for/ })
    .tap();
  await mobile
    .getByRole("menuitem", { name: "Permanently Delete", exact: true })
    .tap();
  await dialog
    .getByRole("button", { name: "Permanently Delete", exact: true })
    .tap();
  await archived.waitFor({ state: "hidden" });
  assert.deepEqual(
    (await page.evaluate(() => window.__qaRepositoryFixture.workspace()))
      .windows,
    desktopBefore.windows,
  );
  record(
    "mobile.delete-independent",
    "Delete cancellation retains the archive; confirmed deletion removes it without changing desktop placement",
  );
  await mobile.screenshot({
    path: path.join(fixture.directory, "conversations-mobile.png"),
    fullPage: true,
  });
} catch (error) {
  if (mobile)
    await mobile
      .screenshot({
        path: path.join(fixture.directory, "conversations-mobile-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(fixture.directory, "conversations-mobile-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  await fixture.close();
}
