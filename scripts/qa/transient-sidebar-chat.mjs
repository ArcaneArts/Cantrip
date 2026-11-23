import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const engine = process.argv[2] ?? "chromium";
const browserType = { chromium, webkit }[engine];
if (!browserType) throw new Error("Expected chromium or webkit");
const evidence =
  process.env.CANTRIP_QA_EVIDENCE ?? "/tmp/cantrip-transient-chat-evidence";
await mkdir(evidence, { recursive: true });
const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
const results = [];
let browser, page;
const record = (event, details) => {
  results.push({ engine, event, status: "pass", details });
  console.log(JSON.stringify(results.at(-1)));
};
try {
  browser = await browserType.launch({ headless: true });
  page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(30000);
  const commands = [];
  const executionStops = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/chats\/[^/]+\/(pause|interrupt)$/.test(new URL(request.url()).pathname)
    )
      executionStops.push(request.url());
    if (request.method() === "POST" && request.url().endsWith("/commands")) {
      const body = request.postDataJSON();
      if (body?.action) commands.push(body.action);
    }
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
  const seed = await page.evaluate(() =>
    window.__qaRepositoryFixture.seedConversations(2, 0),
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

  await page.getByRole("tab", { name: "Chats", exact: true }).click();
  const firstId = seed.active[0];
  const secondId = seed.active[1];
  const chatButton = (id) => page.locator(`[data-conversation-id="${id}"]`);
  const composer = page.getByPlaceholder(
    "Ask Cantrip to work on this repository…",
    { exact: true },
  );
  const workspace = () =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const assertDirect = async (id) => {
    await page.waitForFunction(async (chatId) => {
      const layout = await window.__qaRepositoryFixture.workspace();
      return layout.windows.some((w) =>
        w.panes.some(
          (p) =>
            p.selection?.kind === "conversation" &&
            p.conversationView?.resource.resourceId === chatId,
        ),
      );
    }, id);
  };
  const assertEmpty = async () => {
    await page.locator('[aria-label="Empty workspace"]').waitFor();
    const layout = await workspace();
    assert.equal(
      layout.windows
        .flatMap((w) => w.panes)
        .filter((p) => p.region === "center").length,
      0,
    );
    assert.equal(
      layout.windows.flatMap((w) => w.panes).some((p) => p.conversationView),
      false,
    );
    assert.equal(await composer.count(), 0);
  };
  const close = async (title) => {
    const tab = page
      .locator("[data-project-tab-key]")
      .filter({ hasText: title });
    await tab
      .getByRole("button", { name: `Actions for ${title}`, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Close View", exact: true })
      .click();
  };
  const create = async (kind) => {
    await page
      .getByRole("button", { name: "Add project surface", exact: true })
      .first()
      .click();
    await page.getByRole("menuitem", { name: kind, exact: true }).click();
  };
  await chatButton(firstId).click();
  await assertDirect(firstId);
  await composer.fill("Unsent draft survives the temporary sidebar view.");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "qa.txt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor();
  assert.equal(
    (await workspace()).windows
      .flatMap((w) => w.panes)
      .some((p) => p.conversationView),
    false,
  );
  await close("qa.txt");
  await assertEmpty();
  record(
    "file-close-home",
    "Sidebar chat -> file -> close shows the empty bolt screen",
  );
  await page.screenshot({ path: path.join(evidence, `${engine}-home.png`) });
  await page.reload();
  await assertEmpty();
  record("reload-home", "Persisted layout stays empty after reload");
  await page.getByRole("tab", { name: "Chats", exact: true }).click();
  await chatButton(firstId).click();
  await assertDirect(firstId);
  assert.equal(
    await composer.inputValue(),
    "Unsent draft survives the temporary sidebar view.",
  );
  record(
    "draft-restored",
    "Explicit sidebar click reopens the chat with its unsent draft",
  );
  await create("History");
  await page
    .locator("[data-project-tab-key]")
    .filter({ hasText: "History" })
    .waitFor();
  await close("History");
  await assertEmpty();
  record("history-close-home", "Sidebar chat -> History -> close returns home");
  await chatButton(secondId).click();
  await assertDirect(secondId);
  const secondTitle = (await chatButton(secondId).innerText()).trim();
  await chatButton(secondId)
    .locator("..")
    .getByRole("button", { name: `Actions for ${secondTitle}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Place in top rail", exact: true })
    .click();
  await page
    .locator("[data-project-tab-key]")
    .filter({ hasText: secondTitle })
    .waitFor();
  await chatButton(firstId).click();
  await assertDirect(firstId);
  await page
    .locator("[data-project-tab-key]")
    .filter({ hasText: secondTitle })
    .locator("button")
    .first()
    .click();
  assert.equal(
    (await workspace()).windows
      .flatMap((w) => w.panes)
      .some((p) => p.conversationView),
    false,
  );
  await close(secondTitle);
  await assertEmpty();
  record(
    "existing-agent-close-home",
    "Switching to an existing real Agent tab forgets the tabless chat",
  );
  await chatButton(firstId).click();
  await assertDirect(firstId);
  assert.equal(
    await composer.inputValue(),
    "Unsent draft survives the temporary sidebar view.",
  );
  assert.deepEqual(executionStops, []);
  record(
    "chat-preserved",
    "Chat resource and draft can be reopened after closing the real tab; navigation sends no execution stop",
  );
  await page.screenshot({
    path: path.join(evidence, `${engine}-reopened.png`),
  });
  await writeFile(
    path.join(evidence, `${engine}.json`),
    JSON.stringify({ results, commands, executionStops }, null, 2),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(evidence, `${engine}-failure.png`) })
    .catch(() => {});
  await writeFile(
    path.join(evidence, `${engine}-failure.txt`),
    String(error) +
      "\n" +
      ((await page
        ?.locator("body")
        .innerText()
        .catch(() => "")) ?? ""),
  );
  throw error;
} finally {
  await browser?.close();
  await fixture.close();
}
