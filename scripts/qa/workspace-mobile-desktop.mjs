import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
import {
  seedMobileOverflowFiles,
  verifyMobileOverflow,
} from "./workspace-mobile-overflow.mjs";

const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
const events = [];
const record = (event, details, status = "pass") => {
  const line = "QA_EVT " + JSON.stringify({ event, status, details });
  events.push(line);
  console.log(line);
};
let browser, desktop, mobile;
try {
  await writeFile(
    path.join(fixture.repositorySeed.repository, "main.rs"),
    "fn main() {}\n",
  );
  await seedMobileOverflowFiles(fixture.repositorySeed.repository);
  browser = await chromium.launch({ headless: true });
  desktop = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });
  await desktop.goto(fixture.origin);
  const save = desktop.getByRole("button", {
    name: "Save recovery file",
    exact: true,
  });
  await save.waitFor({ timeout: 90000 });
  const downloaded = desktop.waitForEvent("download");
  await save.click();
  const recovery = path.join(fixture.directory, "disposable-recovery.json");
  await (await downloaded).saveAs(recovery);
  await desktop
    .getByRole("checkbox", {
      name: "I saved the recovery file somewhere I can access later.",
      exact: true,
    })
    .check();
  await desktop
    .getByRole("button", { name: "Continue to Cantrip", exact: true })
    .click();
  let project;
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      project = await desktop.evaluate(() =>
        window.__qaRepositoryFixture.create(),
      );
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
  await desktop.waitForFunction(
    async () =>
      (await window.__qaRepositoryFixture.project())?.setupStatus === "ready",
    undefined,
    { timeout: 90000 },
  );
  await desktop
    .getByRole("button", { name: "Chat. Switch Cantrip mode", exact: true })
    .click();
  await desktop
    .getByRole("menuitem", { name: "Cantrip IDE", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "Switch project", exact: true })
    .click();
  await desktop
    .locator('[data-slot="project-switcher-project"]')
    .filter({ hasText: fixture.repositorySeed.name })
    .click();
  await desktop.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
  await desktop
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor({ timeout: 30000 });
  const tabs = (layout) =>
    layout.windows.flatMap((w) => w.panes.flatMap((p) => p.tabs));
  const previewLayout = await desktop.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  const preview = tabs(previewLayout).find((tab) => tab.preview);
  assert.ok(preview, "Single-click opens an ordinary preview tab");
  await desktop.getByRole("tab", { name: "qa.txt", exact: true }).dblclick();
  await desktop.waitForFunction(async (id) => {
    const layout = await window.__qaRepositoryFixture.workspace();
    return layout.windows
      .flatMap((w) => w.panes.flatMap((p) => p.tabs))
      .some((t) => t.id === id && !t.preview);
  }, preview.id);
  const pinnedLayout = await desktop.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  assert.deepEqual(
    tabs(pinnedLayout),
    tabs(previewLayout).map((tab) =>
      tab.id === preview.id ? { ...tab, preview: false } : tab,
    ),
  );
  record(
    "desktop.double-click-pin",
    "Ordinary tab double-click preserves every tab field except preview",
  );
  const desktopBefore = await desktop.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
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
  await mobile.locator("input[type=file]").setInputFiles(recovery);
  // Account preferences restore IDE mode; this second installation is already in it.
  await mobile
    .getByRole("button", { name: "Open sidebar", exact: true })
    .waitFor({ timeout: 90000 });
  await mobile
    .getByRole("button", { name: "Open sidebar", exact: true })
    .click();
  await mobile
    .getByRole("treeitem", { name: "qa.txt", exact: true })
    .click({ timeout: 30000 });
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor({ timeout: 30000 });
  const mobileFirst = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  assert.notEqual(mobileFirst.id, desktopBefore.id);
  record("device.identities", {
    desktop: desktopBefore.id,
    mobile: mobileFirst.id,
  });
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .fill("Unsaved mobile-only draft\n");
  await mobile
    .getByRole("button", { name: "Open sidebar", exact: true })
    .click();
  await mobile
    .getByRole("treeitem", { name: "second.txt", exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: "Edit second.txt", exact: true })
    .waitFor({ timeout: 30000 });
  const mobileSecond = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  assert.ok(tabs(mobileSecond).length > tabs(mobileFirst).length);
  assert.deepEqual(
    await desktop.evaluate(() => window.__qaRepositoryFixture.workspace()),
    desktopBefore,
  );
  record(
    "mobile.files-isolated",
    "Second file retained dirty first file; desktop authoritative layout unchanged",
  );
  await mobile
    .getByRole("button", { name: "Open qa.txt", exact: true })
    .click();
  assert.equal(
    await mobile
      .getByRole("textbox", { name: "Edit qa.txt", exact: true })
      .inputValue(),
    "Unsaved mobile-only draft\n",
  );
  await mobile.setViewportSize({ width: 1100, height: 844 });
  assert.equal(
    (await mobile.evaluate(() => window.__qaRepositoryFixture.workspace())).id,
    mobileFirst.id,
  );
  await mobile.setViewportSize({ width: 390, height: 844 });
  await delay(2000);
  await mobile.reload();
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await mobile
      .getByRole("textbox", { name: "Edit qa.txt", exact: true })
      .inputValue(),
    "Unsaved mobile-only draft\n",
  );
  assert.deepEqual(
    tabs(
      await mobile.evaluate(() => window.__qaRepositoryFixture.workspace()),
    ).map((t) => t.id),
    tabs(mobileSecond).map((t) => t.id),
  );
  record(
    "mobile.reload-resize",
    "Device identity, distinct tab identities, and unsaved buffer survived resize and reload",
  );
  await mobile
    .getByRole("button", { name: "Choose project tab", exact: true })
    .click();
  const recent = mobile.getByRole("region", { name: "Recently used views" });
  assert.equal(
    await recent.getByRole("button").first().getAttribute("aria-label"),
    "Reopen recent qa.txt",
  );
  await mobile
    .getByRole("button", { name: "Close second.txt view", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: "Close project tabs", exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor();
  record(
    "mobile.close-inactive",
    "Closing inactive second file preserved selected dirty first file",
  );
  await mobile
    .getByRole("button", { name: "Open sidebar", exact: true })
    .click();
  await mobile.getByRole("treeitem", { name: "main.rs", exact: true }).click();
  await mobile
    .getByRole("textbox", { name: "Edit main.rs", exact: true })
    .waitFor({ timeout: 30000 });
  await mobile
    .getByRole("button", { name: "Choose project tab", exact: true })
    .click();
  assert.equal(
    await recent.getByRole("button").first().getAttribute("aria-label"),
    "Reopen recent main.rs",
  );
  const mobilePreview = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  await mobile
    .getByRole("button", { name: "Keep main.rs open", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: "Keep main.rs open", exact: true })
    .waitFor({ state: "hidden" });
  const mobilePinned = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  assert.deepEqual(
    tabs(mobilePinned),
    tabs(mobilePreview).map((tab) =>
      tab.preview ? { ...tab, preview: false } : tab,
    ),
  );
  record(
    "mobile.keep-open",
    "Picker pins preview in place without selecting or closing another view",
  );
  await mobile
    .getByRole("button", { name: "Close main.rs view", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: "Close project tabs", exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor();
  record(
    "mobile.code-close-recent",
    "Code defaults to Edit; recent list follows interaction; closing active last file selects its left neighbor",
  );
  await verifyMobileOverflow({ mobile, desktop, desktopBefore, record });
  assert.deepEqual(
    await desktop.evaluate(() => window.__qaRepositoryFixture.workspace()),
    desktopBefore,
  );
  const mobileBefore = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  await desktop
    .getByRole("treeitem", { name: "second.txt", exact: true })
    .click();
  await desktop
    .getByRole("textbox", { name: "Edit second.txt", exact: true })
    .waitFor();
  const beforeMenu = await desktop.evaluate(() =>
    window.__qaRepositoryFixture.workspace(),
  );
  const menuPreview = tabs(beforeMenu).find((tab) => tab.preview);
  assert.ok(menuPreview);
  let rejectedPin = false;
  const rejectPin = async (route) => {
    if (
      route.request().postDataJSON()?.action?.type === "pin" &&
      !rejectedPin
    ) {
      rejectedPin = true;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "QA pin rejected" }),
      });
    } else await route.continue();
  };
  await desktop.route("**/workspace-layouts/*/commands", rejectPin);
  await desktop
    .getByRole("tab", { name: "second.txt", exact: true })
    .click({ button: "right" });
  const rejectedResponse = desktop.waitForResponse(
    (response) =>
      response.url().includes("/commands") && response.status() === 400,
  );
  await desktop
    .getByRole("menuitem", { name: "Keep Open", exact: true })
    .click();
  await rejectedResponse;
  await desktop
    .locator(`[data-project-tab-key="${menuPreview.id}"][data-preview="true"]`)
    .waitFor();
  assert.ok(rejectedPin);
  assert.deepEqual(
    tabs(
      await desktop.evaluate(() => window.__qaRepositoryFixture.workspace()),
    ),
    tabs(beforeMenu),
  );
  await desktop.unroute("**/workspace-layouts/*/commands", rejectPin);
  record(
    "desktop.pin-failure",
    "Rejected command restores preview without losing identity or other tab state; retry remains available",
  );
  await desktop
    .getByRole("tab", { name: "second.txt", exact: true })
    .click({ button: "right" });
  await desktop
    .getByRole("menuitem", { name: "Keep Open", exact: true })
    .click();
  await desktop.waitForFunction(async (id) => {
    const layout = await window.__qaRepositoryFixture.workspace();
    return layout.windows
      .flatMap((w) => w.panes.flatMap((p) => p.tabs))
      .some((t) => t.id === id && !t.preview);
  }, menuPreview.id);
  assert.deepEqual(
    tabs(
      await desktop.evaluate(() => window.__qaRepositoryFixture.workspace()),
    ),
    tabs(beforeMenu).map((tab) =>
      tab.id === menuPreview.id ? { ...tab, preview: false } : tab,
    ),
  );
  record(
    "desktop.menu-pin",
    "Context menu pins existing preview with stable identity and view state",
  );
  assert.deepEqual(
    await mobile.evaluate(() => window.__qaRepositoryFixture.workspace()),
    mobileBefore,
  );
  record(
    "desktop.files-isolated",
    "Desktop opening/pinning another file leaves mobile authoritative layout unchanged",
  );
  await mobile.screenshot({
    path: path.join(fixture.directory, "mobile.png"),
    fullPage: true,
  });
  await desktop.screenshot({
    path: path.join(fixture.directory, "desktop.png"),
    fullPage: true,
  });
} catch (error) {
  for (const [name, page] of Object.entries({ desktop, mobile }))
    if (page && !page.isClosed()) {
      await page.screenshot({
        path: path.join(fixture.directory, name + "-failure.png"),
        fullPage: true,
      });
      await writeFile(
        path.join(fixture.directory, name + "-failure.txt"),
        await page.locator("body").innerText(),
      );
    }
  record("concurrent-mobile", error.stack, "fail");
  throw error;
} finally {
  try {
    await writeFile(
      path.join(fixture.directory, "workspace-mobile-desktop.log"),
      events.join("\n") + "\n",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await fixture.close();
    }
  }
}
