import assert from "node:assert/strict";
import path from "node:path";
import { open, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser;
  const results = [];
  const record = (event, details) => {
    results.push({ event, ...details });
    console.log(JSON.stringify({ engine: engineName, event, ...details }));
  };
  try {
    const filePath = path.join(
        fixture.repositorySeed.repository,
        "binary-test.nbt",
      ),
      size = 1024 ** 3;
    const handle = await open(filePath, "w");
    try {
      await handle.truncate(size);
      await handle.write(Uint8Array.of(1, 2, 3, 4), 0, 4, size - 4);
    } finally {
      await handle.close();
    }
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const wire = [];
    page.on("request", (request) => {
      if (
        /\/api\/file-documents\/[^/]+\/operation$/.test(
          new URL(request.url()).pathname,
        )
      )
        wire.push(request.postData());
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
    await page.waitForFunction(
      async () => {
        try {
          return (await window.__qaRepositoryFixture.worktrees()).some(
            (tree) => tree.isPrimary && tree.lifecycleState === "ready",
          );
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 90000 },
    );
    let source;
    const encryptionDeadline = Date.now() + 120000;
    for (;;) {
      try {
        source = await page.evaluate(() =>
          window.__qaRepositoryFixture.openBinary("binary-test.nbt"),
        );
        break;
      } catch (error) {
        if (
          Date.now() > encryptionDeadline ||
          (!error.message.includes(
            "Surface stream encryption is unavailable",
          ) &&
            !error.message.includes("Project source not found"))
        )
          throw error;
        await delay(1000);
      }
    }
    assert.equal(source.size, size);
    assert.deepEqual(
      await page.evaluate(
        ({ id, size }) =>
          window.__qaRepositoryFixture.readBinary(id, size - 4, 4),
        { id: source.id, size },
      ),
      [1, 2, 3, 4],
    );
    const fullPage = await page.evaluate(
      (id) => window.__qaRepositoryFixture.readBinary(id, 0, 256 * 1024),
      source.id,
    );
    assert.equal(fullPage.length, 256 * 1024);
    assert.ok(fullPage.every((byte) => byte === 0));
    record("one-gib-range", {
      size,
      tailBytes: 4,
      fullPageBytes: fullPage.length,
    });
    const edit = await open(filePath, "r+");
    try {
      await edit.write(Uint8Array.of(9), 0, 1, size - 2);
    } finally {
      await edit.close();
    }
    await assert.rejects(
      page.evaluate(
        ({ id, size }) =>
          window.__qaRepositoryFixture.readBinary(id, size - 4, 4),
        { id: source.id, size },
      ),
      /changed/i,
    );
    const reopened = await page.evaluate(() =>
      window.__qaRepositoryFixture.openBinary("binary-test.nbt"),
    );
    assert.notEqual(reopened.version, source.version);
    assert.deepEqual(
      await page.evaluate(
        ({ id, size }) =>
          window.__qaRepositoryFixture.readBinary(id, size - 4, 4),
        { id: reopened.id, size },
      ),
      [1, 2, 9, 4],
    );
    record("revision-fencing", { ok: true });
    await page.evaluate(
      (id) => window.__qaRepositoryFixture.closeBinary(id),
      source.id,
    );
    await assert.rejects(
      page.evaluate(
        (id) => window.__qaRepositoryFixture.readBinary(id, 0, 1),
        source.id,
      ),
      /closed/i,
    );
    const cancellable = await page.evaluate(() =>
      window.__qaRepositoryFixture.openBinary("binary-test.nbt"),
    );
    let entered, release;
    const started = new Promise((resolve) => (entered = resolve)),
      held = new Promise((resolve) => (release = resolve));
    const routePattern = `**/api/file-documents/${cancellable.documentId}/operation`;
    const handler = async (route) => {
      entered();
      await held;
      await route.abort().catch(() => {});
    };
    await page.route(routePattern, handler);
    try {
      await page.evaluate(
        ({ id, size }) => {
          window.__qaPendingBinaryRead = window.__qaRepositoryFixture
            .readBinary(id, size - 4, 4)
            .then(
              () => ({ ok: true }),
              (error) => ({ ok: false, error: String(error) }),
            );
        },
        { id: cancellable.id, size },
      );
      await started;
      await page.evaluate(
        (id) => window.__qaRepositoryFixture.closeBinary(id),
        cancellable.id,
      );
      const cancelled = await page.evaluate(() => window.__qaPendingBinaryRead);
      assert.equal(cancelled.ok, false);
      assert.match(cancelled.error, /closed|abort/i);
      record("in-flight-close", { rejected: true });
    } finally {
      release();
      await page.unroute(routePattern, handler);
    }
    assert.ok(wire.length >= 6, "No protected operations observed");
    for (const body of wire) {
      assert.ok(
        body &&
          !body.includes("binary-test.nbt") &&
          !body.includes("explorer.binary.read"),
        "Plaintext file request entered server wire",
      );
      assert.ok(JSON.parse(body).protectedRequest, "Missing protected request");
    }
    record("protected-wire", { operations: wire.length });
    await page.evaluate(() => window.__qaRepositoryFixture.revokeOwner());
    await assert.rejects(
      page.evaluate(
        (id) => window.__qaRepositoryFixture.readBinary(id, 0, 1),
        reopened.id,
      ),
      /closed|account/i,
    );
    record("account-disposal", { prefetchedReadRejected: true });
    await writeFile(
      path.join(fixture.directory, "nbt-binary-results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      JSON.stringify({ engine: engineName, evidence: fixture.directory }),
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
