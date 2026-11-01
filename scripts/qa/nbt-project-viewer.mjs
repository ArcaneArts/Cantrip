import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
const evidence =
  process.env.CANTRIP_NBT_QA_EVIDENCE ?? "/tmp/cantrip-nbt-project-evidence";
await mkdir(evidence, { recursive: true });
for (const [engine, engineType] of Object.entries({ chromium, webkit })) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser, page;
  try {
    const size = 12 * 1024 ** 2,
      head = Buffer.from([
        10, 0, 0, 7, 0, 5, 97, 114, 114, 97, 121, 0, 192, 0, 0,
      ]),
      value = Buffer.from("PROTECTED_TAIL_NEEDLE"),
      name = Buffer.from("tail"),
      tail = Buffer.concat([
        Buffer.from([8, 0, name.length]),
        name,
        Buffer.from([0, value.length]),
        value,
        Buffer.from([0]),
      ]);
    const bytes = gzipSync(Buffer.concat([head, Buffer.alloc(size, 42), tail]));
    await Promise.all([
      writeFile(
        path.join(fixture.repositorySeed.repository, "automatic.nbt"),
        bytes,
      ),
      writeFile(
        path.join(fixture.repositorySeed.repository, "ambiguous.xyz"),
        bytes,
      ),
    ]);
    browser = await engineType.launch({ headless: true });
    page = await browser.newPage({
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
    });
    const wire = [];
    page.on("request", (request) => {
      if (
        /\/api\/(file-documents|explorers)\/[^/]+\/operation$/.test(
          new URL(request.url()).pathname,
        )
      )
        wire.push(request.postData());
    });
    page.setDefaultTimeout(30000);
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

    await page.getByRole("tab", { name: "Files", exact: true }).click();

    const file = (name) => page.getByRole("treeitem", { name, exact: true });
    await file("automatic.nbt").click();
    await page
      .locator('[data-nbt-document-state="complete"]:visible')
      .waitFor({ timeout: 180000 });
    await page
      .getByRole("button", { name: "Find in NBT document", exact: true })
      .click();
    await page
      .getByRole("searchbox", { name: "Find in NBT", exact: true })
      .fill("PROTECTED_TAIL_NEEDLE");
    await page.locator('[data-nbt-search-status="complete"]:visible').waitFor();
    assert.match(
      await page
        .locator('[data-nbt-search-status="complete"]:visible')
        .innerText(),
      /1 of 1 found/,
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "Edit automatic.nbt", exact: true })
        .count(),
      0,
    );
    await page.screenshot({
      path: path.join(evidence, engine + "-protected.png"),
    });
    const oldBinding = await page
      .locator("[data-nbt-viewer]:visible")
      .getAttribute("data-nbt-binding");
    await file("ambiguous.xyz").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open As", exact: true }).hover();
    await page.getByRole("menuitem", { name: "NBT", exact: true }).click();
    await page.waitForFunction(
      (old) =>
        [...document.querySelectorAll("[data-nbt-viewer]")]
          .find((node) => node.getClientRects().length)
          ?.getAttribute("data-nbt-binding") !== old,
      oldBinding,
    );
    await page
      .locator('[data-nbt-document-state="complete"]:visible')
      .waitFor({ timeout: 180000 });
    await page
      .getByRole("button", { name: "Open array array", exact: true })
      .click();
    await page
      .getByLabel("Array element index", { exact: true })
      .fill("12582911");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-nbt-element="12582911"]')
        ?.textContent?.includes("42"),
    );
    assert.ok(wire.length > 0);
    assert.equal(
      wire.some((body) => body?.includes("PROTECTED_TAIL_NEEDLE")),
      false,
    );
    assert.equal(
      wire.some((body) => body?.includes("explorer.binary.read")),
      false,
    );
    const result = {
      ok: true,
      engine,
      expandedBytes: size,
      protectedRequests: wire.length,
      automatic: true,
      openAs: true,
      tailSearch: true,
      lastArrayElement: true,
    };
    await writeFile(
      path.join(evidence, engine + "-project.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    await page
      ?.screenshot({
        path: path.join(evidence, engine + "-project-failure.png"),
      })
      .catch(() => {});
    await writeFile(
      path.join(evidence, engine + "-project-failure.txt"),
      String(error.stack) +
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
}
