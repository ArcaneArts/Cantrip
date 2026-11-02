import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
const evidence =
  process.env.CANTRIP_NBT_QA_EVIDENCE ??
  "/tmp/cantrip-nbt-local-project-evidence";
await mkdir(evidence, { recursive: true });
const reference = createRequire(
  path.join(process.cwd(), "packages/nbt/package.json"),
)("nbtify");
for (const [engine, engineType] of Object.entries({ chromium, webkit }).filter(
  ([name]) =>
    !process.env.CANTRIP_NBT_QA_ENGINE ||
    process.env.CANTRIP_NBT_QA_ENGINE === name,
)) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser, page;
  try {
    const project = Buffer.from([
        10, 0, 0, 4, 0, 1, 110, 0, 0, 0, 0, 0, 0, 0, 1, 0,
      ]),
      projectBytes = gzipSync(project),
      size = Number(process.env.CANTRIP_NBT_QA_MIB ?? 1) * 1024 ** 2,
      number = Buffer.from(project),
      marker = Buffer.from("CLIENT_ONLY_LOCAL_MARKER"),
      array = Buffer.from([7, 0, 5, 97, 114, 114, 97, 121, 0, 0, 0, 0]);
    number.writeBigInt64BE(9007199254740993n, 7);
    array.writeInt32BE(size, 8);
    const localPayload = Buffer.concat([
        number.subarray(0, -1),
        Buffer.from([8, 0, 6]),
        Buffer.from("marker"),
        Buffer.from([0, marker.length]),
        marker,
        array,
        Buffer.alloc(size, 42),
        Buffer.from([0]),
      ]),
      localBytes =
        process.env.CANTRIP_NBT_QA_RAW === "true"
          ? localPayload
          : gzipSync(localPayload);
    await writeFile(
      path.join(fixture.repositorySeed.repository, "project.nbt"),
      projectBytes,
    );
    const localPath = path.join(fixture.directory, "client-only.nbt");
    await writeFile(localPath, localBytes);
    browser = await engineType.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      // Exercise the streaming download fallback in both engines; destination
      // picker writing is covered separately with an actual writable handle.
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [],
      reloadRequestCancellations = [];
    let reloading = false;
    const reload = async () => {
      reloading = true;
      try {
        await page.reload();
      } finally {
        reloading = false;
      }
    };
    page.on("pageerror", (error) => {
      // WebKit reports aborted, old-document peer signalling fetches as CORS
      // failures during renderer reload. Keep the evidence; errors while the
      // current document is running still fail this test.
      if (
        reloading &&
        error.message.includes(new URL(fixture.origin).host) &&
        /\/api\/worker-links\/[^/]+\/peers(?:\/| due)/u.test(error.message) &&
        error.message.endsWith("due to access control checks.")
      ) {
        reloadRequestCancellations.push(error.message);
      } else {
        console.log(
          JSON.stringify({
            engine,
            stage: "page-error",
            reloading,
            message: error.message,
            stack: error.stack,
          }),
        );
        errors.push(error.message);
      }
    });
    await page.goto(fixture.origin);
    const saveRecovery = page.getByRole("button", {
      name: "Save recovery file",
      exact: true,
    });
    await saveRecovery.waitFor({ timeout: 90000 });
    const download = page.waitForEvent("download");
    await saveRecovery.click();
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
    await file("project.nbt").click();
    const projectView = page.locator('[data-nbt-source="project"]:visible'),
      local = page.locator('[data-nbt-source="local"]:visible');
    const complete = (view) =>
      view
        .locator('[data-nbt-document-state="complete"]')
        .waitFor({ timeout: 180000 });
    await complete(projectView);
    await projectView
      .getByLabel("Choose local NBT file", { exact: true })
      .setInputFiles(localPath);
    await complete(local);
    await local
      .getByRole("button", { name: "Toggle NBT editing", exact: true })
      .waitFor();
    await page.waitForFunction(() => {
      const view = [
        ...document.querySelectorAll('[data-nbt-source="local"]'),
      ].find((view) => view.getClientRects().length);
      return (
        view &&
        !view.querySelector('[aria-label="Toggle NBT editing"]')?.disabled
      );
    });
    assert.equal(
      await local.getByRole("button", { name: "Save", exact: true }).count(),
      0,
      "local source cannot save over the project path",
    );
    assert.match(await local.innerText(), /client-only\.nbt · local/);
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /9007199254740993/,
    );
    console.log(
      JSON.stringify({ engine, stage: "local-opened", expandedBytes: size }),
    );
    const editNumber = async (value) => {
      if (
        (await local
          .getByRole("button", { name: "Toggle NBT editing", exact: true })
          .getAttribute("aria-pressed")) !== "true"
      )
        await local
          .getByRole("button", { name: "Toggle NBT editing", exact: true })
          .click();
      await local.locator('[data-nbt-node="node:1"]').click();
      await local
        .getByRole("button", { name: "Edit value", exact: true })
        .click();
      await local.getByLabel("NBT edit value", { exact: true }).fill(value);
      await local.getByRole("button", { name: "Apply", exact: true }).click();
      await local.getByRole("dialog").waitFor({ state: "detached" });
      await local.locator('[data-nbt-dirty="true"]').waitFor();
    };
    await editNumber("77");
    const cancelledReplacement = page
      .waitForEvent("dialog")
      .then(async (dialog) => {
        assert.match(dialog.message(), /discard this local file/);
        await dialog.dismiss();
      });
    await local
      .getByLabel("Choose local NBT file", { exact: true })
      .setInputFiles({
        name: "not-opened.nbt",
        mimeType: "application/octet-stream",
        buffer: projectBytes,
      });
    await cancelledReplacement;
    assert.match(await local.innerText(), /client-only\.nbt · local/);
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /77/,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await reload();
    await complete(local);
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /77/,
    );
    assert.equal(
      await local.getByRole("button", { name: "Save", exact: true }).count(),
      0,
    );
    await local
      .getByRole("button", { name: "Toggle NBT editing", exact: true })
      .click();
    await local.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[data-nbt-source="local"]')]
          .find((view) => view.getClientRects().length)
          ?.querySelector('[data-nbt-dirty="true"]'),
    );
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /9007199254740993/,
    );
    await local
      .getByLabel("NBT encoding", { exact: true })
      .selectOption("java");
    await complete(local);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[aria-label="NBT encoding"]')].some(
          (select) => select.getClientRects().length && select.value === "java",
        ),
      undefined,
      { timeout: 180000 },
    );
    await reload();
    await complete(local);
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /9007199254740993/,
    );
    console.log(JSON.stringify({ engine, stage: "reload-undo-format-reload" }));
    await editNumber("88");
    if (process.env.CANTRIP_NBT_QA_CANCEL_EXPORT === "true") {
      const partialCopy = page.waitForEvent("download");
      await local
        .getByRole("button", { name: "Export Copy…", exact: true })
        .click();
      const partial = await partialCopy;
      await local
        .getByRole("button", { name: "Cancel export", exact: true })
        .click();
      await local
        .locator('[data-nbt-export="complete"]')
        .filter({ hasText: "Export cancelled" })
        .waitFor();
      assert.ok(
        await partial.failure(),
        "cancelled download cannot be reported as a complete file",
      );
      assert.equal(await local.locator('[data-nbt-dirty="true"]').count(), 1);
    }
    const downloadCopy = page.waitForEvent("download");
    await local
      .getByRole("button", { name: "Export Copy…", exact: true })
      .click();
    const exported = await downloadCopy,
      exportPath = path.join(evidence, engine + "-exported.nbt");
    await exported.saveAs(exportPath);
    await local.locator('[data-nbt-export="complete"]').waitFor();
    assert.equal(exported.suggestedFilename(), "client-only.nbt");
    const exportDocument = await reference.read(await readFile(exportPath));
    assert.equal(exportDocument.data.n, 88n);
    assert.equal(exportDocument.data.marker, "CLIENT_ONLY_LOCAL_MARKER");
    assert.equal(exportDocument.data.array.length, size);
    assert.ok(exportDocument.data.array.every((value) => value === 42));
    assert.equal(
      await local.locator('[data-nbt-dirty="true"]').count(),
      1,
      "exporting a copy does not acknowledge or discard the draft",
    );
    await local.getByRole("button", { name: "Save As…", exact: true }).click();
    await local
      .getByLabel("NBT Save As path", { exact: true })
      .fill("local-copy.nbt");
    await local
      .getByRole("button", { name: "Save new file", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-nbt-source="project"]')].some(
          (view) =>
            view.getClientRects().length &&
            view.querySelector('[data-nbt-document-state="complete"]') &&
            view.textContent?.includes("CLIENT_ONLY_LOCAL_MARKER"),
        ),
      undefined,
      { timeout: 180000 },
    );
    const copied = await reference.read(
      await readFile(
        path.join(fixture.repositorySeed.repository, "local-copy.nbt"),
      ),
    );
    assert.equal(copied.data.n, 88n);
    assert.equal(copied.data.marker, "CLIENT_ONLY_LOCAL_MARKER");
    assert.equal(copied.data.array.length, size);
    assert.ok(copied.data.array.every((value) => value === 42));
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "project.nbt"),
      ),
      projectBytes,
    );
    await file("project.nbt").click();
    await complete(local);
    page.once("dialog", (dialog) => dialog.accept());
    await local
      .getByRole("button", { name: "Return to project file", exact: true })
      .click();
    await complete(projectView);
    assert.match(
      await projectView.locator('[data-nbt-node="node:1"]').innerText(),
      /1/,
    );
    await reload();
    await complete(projectView);
    await projectView
      .getByLabel("Choose local NBT file", { exact: true })
      .setInputFiles({
        name: "broken.nbt",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([10, 0, 0, 99]),
      });
    await projectView
      .getByRole("button", { name: "Toggle NBT editing", exact: true })
      .waitFor();
    await page
      .getByRole("alert")
      .filter({ hasText: /NBT|tag/i })
      .first()
      .waitFor();
    await complete(projectView);
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "project.nbt"),
      ),
      projectBytes,
    );
    await projectView
      .getByLabel("Choose local NBT file", { exact: true })
      .setInputFiles({
        name: "first.nbt",
        mimeType: "application/octet-stream",
        buffer: projectBytes,
      });
    await complete(local);
    await editNumber("77");
    const acceptedReplacement = page
      .waitForEvent("dialog")
      .then(async (dialog) => {
        assert.match(dialog.message(), /discard this local file/);
        await dialog.accept();
      });
    await local
      .getByLabel("Choose local NBT file", { exact: true })
      .setInputFiles({
        name: "second.nbt",
        mimeType: "application/octet-stream",
        buffer: projectBytes,
      });
    await acceptedReplacement;
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-nbt-source="local"]')].some(
        (view) =>
          view.getClientRects().length &&
          view.textContent.includes("second.nbt · local"),
      ),
    );
    await complete(local);
    // Parsing is progressive; wait for the actual recovery publication before
    // intentionally tearing down this freshly imported, still clean source.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-nbt-source="local"]')].some(
        (view) =>
          view.getClientRects().length &&
          view.querySelector('[aria-label="Toggle NBT editing"]')?.disabled ===
            false,
      ),
    );
    await reload();
    await complete(local);
    assert.match(await local.innerText(), /second\.nbt · local/);
    assert.match(
      await local.locator('[data-nbt-node="node:1"]').innerText(),
      /1/,
    );
    assert.equal(await local.locator('[data-nbt-dirty="true"]').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: path.join(evidence, engine + "-local-project.png"),
    });
    const result = {
      ok: true,
      engine,
      expandedArrayBytes: size,
      localSourceBytes: localBytes.length,
      exportedBytes: (await readFile(exportPath)).length,
      localFileInput: true,
      encryptedOriginalBeforeFirstEdit: true,
      noProjectSaveTarget: true,
      localDraftReload: true,
      exactLong: true,
      undoAfterReload: true,
      atomicFormatReplacementAndReload: true,
      streamingBrowserExport: true,
      cancelledStreamingExport:
        process.env.CANTRIP_NBT_QA_CANCEL_EXPORT === "true",
      exportRetainsDirtyDraft: true,
      explicitProtectedSaveAs: true,
      independentParser: true,
      returnToProject: true,
      failedImportRollback: true,
      cancelledDirtyReplacement: true,
      confirmedDirtyReplacementAndReload: true,
      originalProjectUnchanged: true,
      reloadRequestCancellations,
    };
    await writeFile(
      path.join(evidence, engine + "-local-project.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    await context.close();
  } catch (error) {
    await page
      ?.screenshot({ path: path.join(evidence, engine + "-local-failure.png") })
      .catch(() => {});
    await writeFile(
      path.join(evidence, engine + "-local-failure.txt"),
      String(error.stack) +
        "\n" +
        (await page
          ?.locator("body")
          .innerText()
          .catch(() => "")),
    );
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await fixture.close();
  }
}
