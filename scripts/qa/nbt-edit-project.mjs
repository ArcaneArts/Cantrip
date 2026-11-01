import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
const evidence =
  process.env.CANTRIP_NBT_QA_EVIDENCE ??
  "/tmp/cantrip-nbt-edit-project-evidence";
await mkdir(evidence, { recursive: true });
for (const [engine, engineType] of Object.entries({ chromium, webkit }).filter(
  ([name]) =>
    !process.env.CANTRIP_NBT_QA_ENGINE ||
    process.env.CANTRIP_NBT_QA_ENGINE === name,
)) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser, page;
  try {
    const size = Number(process.env.CANTRIP_NBT_QA_MIB ?? 100) * 1024 ** 2,
      head = Buffer.from([
        10, 0, 0, 7, 0, 5, 97, 114, 114, 97, 121, 6, 64, 0, 0,
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
    assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 1024 ** 3);
    head.writeInt32BE(size, 11);
    const bytes = gzipSync(Buffer.concat([head, Buffer.alloc(size, 42), tail]));
    const quickPayload = Buffer.alloc(16);
    quickPayload.set([10, 0, 0, 4, 0, 1, 110]);
    quickPayload.writeBigInt64BE(1n, 7);
    const quickBytes = gzipSync(quickPayload);
    await Promise.all([
      writeFile(
        path.join(fixture.repositorySeed.repository, "automatic.nbt"),
        bytes,
      ),
      writeFile(
        path.join(fixture.repositorySeed.repository, "ambiguous.xyz"),
        bytes,
      ),
      writeFile(
        path.join(fixture.repositorySeed.repository, "quick.nbt"),
        quickBytes,
      ),
    ]);
    browser = await engineType.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
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
    const viewer = page.locator("[data-nbt-viewer]:visible");
    await page
      .getByRole("button", { name: "Close NBT find", exact: true })
      .click();
    await viewer
      .getByRole("button", { name: "Toggle NBT editing", exact: true })
      .click();
    const action = (name) => viewer.getByRole("button", { name, exact: true });
    const sheet = page.getByRole("dialog");
    const apply = async () => {
      await sheet.getByRole("button", { name: "Apply", exact: true }).click();
      await sheet.waitFor({ state: "detached" });
    };
    await action("Edit value").click();
    await sheet
      .getByRole("textbox", { name: "NBT edit value", exact: true })
      .fill("UPDATED_TAIL_NEEDLE");
    await apply();
    await viewer
      .locator('[data-nbt-node="node:2"]')
      .filter({ hasText: "UPDATED_TAIL_NEEDLE" })
      .waitFor();
    await action("Rename").click();
    await sheet
      .getByRole("textbox", { name: "NBT property name", exact: true })
      .fill("renamedTail");
    await apply();
    await viewer.locator('[data-nbt-node="node:0"]').click();
    await action("Add tag").click();
    await sheet.getByLabel("NBT property name", { exact: true }).fill("long");
    await sheet
      .getByLabel("New NBT tag type", { exact: true })
      .selectOption("4");
    await sheet
      .getByLabel("NBT edit value", { exact: true })
      .fill("9223372036854775807");
    await apply();
    await viewer
      .getByRole("row")
      .filter({ hasText: "9223372036854775807" })
      .waitFor();
    await action("Duplicate").click();
    await sheet
      .getByLabel("NBT property name", { exact: true })
      .fill("longCopy");
    await apply();
    await viewer.getByRole("row").filter({ hasText: "longCopy" }).waitFor();
    await action("Delete").click();
    await sheet.getByRole("button", { name: "Delete", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await action("Undo").click();
    await viewer.getByRole("row").filter({ hasText: "longCopy" }).waitFor();
    await action("Redo").click();
    await viewer
      .getByRole("row")
      .filter({ hasText: "longCopy" })
      .waitFor({ state: "detached" });
    await viewer
      .getByRole("button", { name: "Open array array", exact: true })
      .click();
    await action("Edit array range").click();
    await sheet
      .getByLabel("NBT edit index", { exact: true })
      .fill(String(size - 1));
    await sheet.getByLabel("NBT remove count", { exact: true }).fill("1");
    await sheet.getByLabel("NBT edit value", { exact: true }).fill("-7");
    await apply();
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "automatic.nbt"),
      ),
      bytes,
    );
    assert.equal(
      await viewer.getByLabel("NBT encoding", { exact: true }).isDisabled(),
      true,
    );
    const recovery = process.env.CANTRIP_NBT_QA_RECOVERY === "true";
    if (recovery) {
      page.once("dialog", (dialog) => dialog.accept());
      await page.reload();
      await page
        .locator('[data-nbt-document-state="complete"]:visible')
        .waitFor({ timeout: 180000 });
      await viewer.locator('[data-nbt-dirty="true"]').waitFor();
      await viewer
        .getByRole("row")
        .filter({ hasText: "9223372036854775807" })
        .waitFor();
      await action("Toggle NBT editing").click();
      assert.equal(await action("Undo").isEnabled(), true);
      await action("Undo").click();
      await action("Redo").click();
      assert.deepEqual(
        await readFile(
          path.join(fixture.repositorySeed.repository, "automatic.nbt"),
        ),
        bytes,
      );
      await page.screenshot({
        path: path.join(evidence, engine + "-recovered-draft.png"),
      });
    }
    await viewer
      .getByRole("button", { name: "Find in NBT document", exact: true })
      .click();
    await viewer
      .getByRole("searchbox", { name: "Find in NBT", exact: true })
      .fill("UPDATED_TAIL_NEEDLE");
    await viewer.locator('[data-nbt-search-status="complete"]').waitFor();
    assert.match(
      await viewer.locator('[data-nbt-search-status="complete"]').innerText(),
      /1 of 1 found/,
    );
    await viewer
      .getByRole("button", { name: "Close NBT find", exact: true })
      .click();
    let closePrompt = "";
    await page
      .getByRole("tab", { name: "automatic.nbt", exact: true })
      .click({ button: "right" });
    page.once("dialog", async (dialog) => {
      closePrompt = dialog.message();
      await dialog.dismiss();
    });
    await page
      .getByRole("menuitem", { name: "Close View", exact: true })
      .click();
    assert.match(closePrompt, /unsaved changes/i);
    assert.equal(await viewer.locator('[data-nbt-dirty="true"]').count(), 1);
    let dropped = false;
    await page.route("**/api/file-documents/*/operation", async (route) => {
      const response = await route.fetch();
      const current = await readFile(
        path.join(fixture.repositorySeed.repository, "automatic.nbt"),
      );
      if (!dropped && !current.equals(bytes)) {
        dropped = true;
        await route.abort("failed");
      } else await route.fulfill({ response });
    });
    await action("Save").click();
    await viewer
      .locator('[data-nbt-dirty="false"]')
      .waitFor({ timeout: 180000 });
    assert.equal(
      dropped,
      true,
      "commit acknowledgement was deliberately dropped",
    );
    const saved = await readFile(
      path.join(fixture.repositorySeed.repository, "automatic.nbt"),
    );
    const expanded = gunzipSync(saved);
    assert.equal(expanded[15], 42);
    assert.equal(expanded[15 + size - 1], 249);
    assert.ok(expanded.includes(Buffer.from("renamedTail")));
    assert.ok(expanded.includes(Buffer.from("UPDATED_TAIL_NEEDLE")));
    assert.ok(!expanded.includes(Buffer.from("longCopy")));
    const { createRequire } = await import("node:module");
    const reference = createRequire(
      path.join(process.cwd(), "packages/nbt/package.json"),
    )("nbtify");
    const independent = await reference.read(saved);
    assert.equal(independent.data.long, 9223372036854775807n);
    assert.equal(independent.data.renamedTail, "UPDATED_TAIL_NEEDLE");
    assert.equal(independent.data.array.length, size);
    assert.equal(independent.data.array.at(-1), -7);
    await page.screenshot({
      path: path.join(evidence, engine + "-edited-saved.png"),
    });
    await page.reload();
    await page
      .locator('[data-nbt-document-state="complete"]:visible')
      .waitFor({ timeout: 180000 });
    await page
      .getByRole("row")
      .filter({ hasText: "9223372036854775807" })
      .waitFor();
    const reopened = page.locator("[data-nbt-viewer]:visible");
    await reopened
      .getByRole("button", { name: "Toggle NBT editing", exact: true })
      .click();
    await reopened
      .getByRole("row")
      .filter({ hasText: "9223372036854775807" })
      .click();
    await reopened
      .getByRole("button", { name: "Edit value", exact: true })
      .click();
    await sheet.getByLabel("NBT edit value", { exact: true }).fill("7");
    await apply();
    const externallyChanged = Buffer.from([99]);
    await writeFile(
      path.join(fixture.repositorySeed.repository, "automatic.nbt"),
      externallyChanged,
    );
    await reopened.getByRole("button", { name: "Save", exact: true }).click();
    await reopened.getByRole("alert").filter({ hasText: "draft" }).waitFor();
    assert.equal(await reopened.locator('[data-nbt-dirty="true"]').count(), 1);
    page.once("dialog", (dialog) => dialog.accept());
    await reopened
      .getByRole("button", { name: "Reload from disk", exact: true })
      .click();
    await reopened
      .getByRole("alert")
      .filter({ hasText: /NBT|compressed input/i })
      .first()
      .waitFor();
    assert.equal(
      await reopened.locator('[data-nbt-dirty="true"]').count(),
      1,
      "failed reload retains the old draft",
    );
    await reopened
      .getByRole("button", { name: "Save As…", exact: true })
      .click();
    await reopened
      .getByLabel("NBT Save As path", { exact: true })
      .fill("saved-copy.nbt");
    await reopened
      .getByRole("button", { name: "Save new file", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-nbt-viewer]")].some(
          (view) =>
            view.getClientRects().length &&
            !view.querySelector('[data-nbt-dirty="true"]') &&
            [...view.querySelectorAll("[data-nbt-node]")].some((row) =>
              row.textContent?.includes("renamedTail"),
            ),
        ),
      undefined,
      { timeout: 180000 },
    );
    const copied = await reference.read(
      await readFile(
        path.join(fixture.repositorySeed.repository, "saved-copy.nbt"),
      ),
    );
    assert.equal(copied.data.long, 7n);
    assert.equal(copied.data.array.at(-1), -7);
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "automatic.nbt"),
      ),
      externallyChanged,
    );
    await page.screenshot({
      path: path.join(evidence, engine + "-save-as.png"),
    });
    if (recovery) {
      await file("quick.nbt").click();
      const quick = page.locator(
        '[data-nbt-viewer]:visible[data-nbt-binding*="quick.nbt"]',
      );
      await quick.locator('[data-nbt-document-state="complete"]').waitFor();
      await quick
        .getByLabel("NBT compression", { exact: true })
        .selectOption("gzip");
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[aria-label="NBT compression"]')].some(
          (select) => select.getClientRects().length && select.value === "gzip",
        ),
      );
      await quick.locator('[data-nbt-document-state="complete"]').waitFor();
      await quick
        .getByRole("button", { name: "Toggle NBT editing", exact: true })
        .click();
      await quick.locator('[data-nbt-node="node:1"]').click();
      await quick
        .getByRole("button", { name: "Edit value", exact: true })
        .click();
      await sheet.getByLabel("NBT edit value", { exact: true }).fill("42");
      await apply();
      page.once("dialog", (dialog) => dialog.accept());
      await page.reload();
      await quick.locator('[data-nbt-document-state="complete"]').waitFor();
      await quick.locator('[data-nbt-dirty="true"]').waitFor();
      assert.match(
        await quick.locator('[data-nbt-node="node:1"]').innerText(),
        /42/,
      );
      assert.deepEqual(
        await readFile(
          path.join(fixture.repositorySeed.repository, "quick.nbt"),
        ),
        quickBytes,
      );
    }
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
      expandedArrayBytes: size,
      expandedBytes: expanded.length,
      compressedBytes: saved.length,
      protectedRequests: wire.length,
      automatic: true,
      typedEdits: true,
      lostCommitReply: dropped,
      independentReopen: true,
      dirtyCloseCancellation: true,
      encryptedDraftReload: recovery,
      replacementRetainsRecovery: recovery,
      conflictRetainsDraft: true,
      failedReloadRetainsDraft: true,
      saveAsCreatesNewDocument: true,
      tailSearch: true,
      lastArrayElementEdit: true,
    };
    await writeFile(
      path.join(evidence, engine + "-edit-project.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    await page
      ?.screenshot({
        path: path.join(evidence, engine + "-edit-project-failure.png"),
      })
      .catch(() => {});
    await writeFile(
      path.join(evidence, engine + "-edit-project-failure.txt"),
      String(error.stack) +
        "\n" +
        ((await page
          ?.locator("body")
          .innerText()
          .catch(() => "")) ?? ""),
    );
    await writeFile(
      path.join(evidence, engine + "-edit-project-state.json"),
      JSON.stringify(
        await page
          ?.locator("[data-nbt-viewer]")
          .evaluateAll((views) =>
            views.map((view) => ({
              visible: Boolean(view.getClientRects().length),
              binding: view.getAttribute("data-nbt-binding"),
              controls: [...view.querySelectorAll("select")].map((select) => ({
                name: select.getAttribute("aria-label"),
                value: select.value,
                disabled: select.disabled,
              })),
              state: view
                .querySelector("[data-nbt-document-state]")
                ?.getAttribute("data-nbt-document-state"),
            })),
          )
          .catch(() => []),
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await page?.unrouteAll({ behavior: "wait" }).catch(() => {});
    await browser?.close();
    await fixture.close();
  }
}
