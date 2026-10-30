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
  const requests = [];
  const pages = [];
  const reads = [];
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname.endsWith("/conversations") &&
      response.ok()
    )
      reads.push(
        response.json().then((body) => {
          assert.ok(body.items.length <= 50);
          pages.push(body);
        }),
      );
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
  const smallSeed = await page.evaluate(() =>
    window.__qaRepositoryFixture.seedConversations(10, 10),
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
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await page.getByText("10 Conversations", { exact: true }).waitFor();
  const active = page.getByRole("list", {
    name: "Active conversations",
    exact: true,
  });
  const archived = page.getByRole("list", {
    name: "Archived conversation list",
    exact: true,
  });
  const small = {
    mounted: await page.locator("[data-virtual-conversation]").count(),
    requests: requests.length,
  };
  record("small-list", small);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const start = performance.now();
  await page.evaluate(() =>
    window.__qaRepositoryFixture.seedConversations(990, 990),
  );
  record("seeded-2000", { milliseconds: performance.now() - start });
  const beforeReads = requests.length;
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await page
    .getByText("1000 Conversations", { exact: true })
    .waitFor({ timeout: 90000 });
  await page
    .getByRole("heading", { name: "Archived 1000", exact: true })
    .waitFor();
  for (const [list, name] of [
    [active, "Load more conversations"],
    [archived, "Load more archived conversations"],
  ]) {
    const more = page.getByRole("button", { name, exact: true });
    for (let index = 0; index < 19; index++) {
      await more.click();
      await page.waitForFunction(
        ({ label, count }) => {
          const list = [...document.querySelectorAll('[role="list"]')].find(
            (el) => el.getAttribute("aria-label") === label,
          );
          return list?.querySelector('[aria-setsize="' + count + '"]');
        },
        {
          label: await list.getAttribute("aria-label"),
          count: (index + 2) * 50,
        },
      );
      assert.ok(
        (await page.locator("[data-virtual-conversation]").count()) < 70,
      );
    }
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await list.locator('[aria-posinset="1000"]').waitFor();
    await list.locator('[aria-posinset="1000"] button').first().focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () =>
        document.activeElement
          ?.closest('[role="listitem"]')
          ?.getAttribute("aria-posinset") === "1",
    );
    await page.keyboard.press("End");
    await page.waitForFunction(
      () =>
        document.activeElement
          ?.closest('[role="listitem"]')
          ?.getAttribute("aria-posinset") === "1000",
    );
  }
  await Promise.all(reads);
  const catalog = pages.filter((page) => page.total === 1000);
  for (const state of ["active", "archived"]) {
    const ids = new Set(
      catalog
        .filter((page) => page.state === state)
        .flatMap((page) => page.items.map((chat) => chat.id)),
    );
    assert.equal(ids.size, 1000, state + " complete catalog");
  }
  const transcriptRequests = requests
    .slice(beforeReads)
    .filter((url) => /\/chats\/[^/]+\/messages/.test(url));
  assert.equal(transcriptRequests.length, 0);
  record("large-list", {
    mounted: await page.locator("[data-virtual-conversation]").count(),
    catalogPages: catalog.length,
    transcriptRequests: transcriptRequests.length,
    requests: requests.length - beforeReads,
  });
  await active.scrollIntoViewIfNeeded();
  await active.evaluate((el) => {
    el.scrollTop = 16000;
  });
  await page.waitForFunction(() => {
    const list = document.querySelector('[aria-label="Active conversations"]');
    const box = list.getBoundingClientRect();
    return [...list.querySelectorAll("[data-virtual-conversation]")].some(
      (row) =>
        row.getBoundingClientRect().bottom > box.top &&
        row.getBoundingClientRect().top < box.bottom,
    );
  });
  const anchor = await active.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const row = [...el.querySelectorAll("[data-virtual-conversation]")].find(
      (row) =>
        row.getBoundingClientRect().bottom > box.top &&
        row.getBoundingClientRect().top < box.bottom,
    );
    return {
      id: row.dataset.virtualConversation,
      offset: row.getBoundingClientRect().top - box.top,
    };
  });
  await Promise.all([
    page.waitForResponse(async (response) => {
      if (
        !new URL(response.url()).pathname.endsWith("/conversations") ||
        !response.ok()
      )
        return false;
      const body = await response.json();
      return (
        body.state === "active" &&
        body.total === 1000 &&
        body.nextCursor === null
      );
    }),
    page.evaluate(
      (id) => window.__qaRepositoryFixture.useConversation(id),
      smallSeed.active[0],
    ),
  ]);
  await page.waitForFunction(({ id, offset }) => {
    const row = [
      ...document.querySelectorAll("[data-virtual-conversation]"),
    ].find((row) => row.dataset.virtualConversation === id);
    const viewport = row?.closest('[role="list"]');
    return (
      row &&
      Math.abs(
        row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          offset,
      ) < 2
    );
  }, anchor);
  record("live-anchor", anchor);
  await page.screenshot({
    path: path.join(fixture.directory, "conversations-scale.png"),
    fullPage: true,
  });
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(fixture.directory, "conversations-scale-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(fixture.directory, "conversations-scale-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  await fixture.close();
}
