import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const results = [];
for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
  let browser;
  try {
    await mkdir(path.join(fixture.repositorySeed.repository, "assets"));
    browser = await browserType.launch({ headless: true });
    const page = await browser.newPage({
      acceptDownloads: true,
      colorScheme: engine === "chromium" ? "dark" : "light",
      viewport: { width: 1280, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        /\/explorers\/[^/]+\/operation$/u.test(new URL(request.url()).pathname)
      ) {
        assert.ok(
          !request.postData()?.includes("SENTINEL"),
          "file paths and contents remain encrypted on the server relay",
        );
      }
    });
    await page.goto(fixture.origin);
    const save = page.getByRole("button", {
      name: "Save recovery file",
      exact: true,
    });
    await save.waitFor({ timeout: 90_000 });
    const download = page.waitForEvent("download");
    await save.click();
    await (
      await download
    ).saveAs(path.join(fixture.directory, "recovery.json"));
    await page
      .getByRole("checkbox", {
        name: "I saved the recovery file somewhere I can access later.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Continue to Cantrip", exact: true })
      .click();
    const deadline = Date.now() + 90_000;
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
      { timeout: 90_000 },
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
    const tree = page.getByRole("tree", { name: "Project files", exact: true });
    const assets = page.getByRole("treeitem", { name: "assets", exact: true });
    await assets.waitFor({ timeout: 90_000 });
    const transfer = async (files) =>
      page.evaluateHandle(
        (files) => {
          const data = new DataTransfer();
          for (const file of files)
            data.items.add(
              new File(
                [
                  Uint8Array.from(atob(file.data), (value) =>
                    value.charCodeAt(0),
                  ),
                ],
                file.name,
              ),
            );
          return data;
        },
        files.map(([name, bytes]) => ({
          name,
          data: Buffer.from(bytes).toString("base64"),
        })),
      );
    const text = Buffer.from("\uFEFFSENTINEL text\r\nsecond line\r\n", "utf8");
    let data = await transfer([["SENTINEL-drop.txt", text]]);
    await tree.dispatchEvent("dragover", { dataTransfer: data });
    assert.match(
      await page
        .getByRole("status")
        .filter({ hasText: "Drop files into" })
        .textContent(),
      /project root/u,
    );
    await tree.dispatchEvent("drop", { dataTransfer: data });
    await page
      .getByRole("treeitem", { name: "SENTINEL-drop.txt", exact: true })
      .waitFor();
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "SENTINEL-drop.txt"),
      ),
      text,
    );
    await data.dispose();

    const binary = Buffer.from(
      Uint8Array.from({ length: 600_017 }, (_, index) => index % 256),
    );
    data = await transfer([["SENTINEL-image.bin", binary]]);
    assert.equal(await assets.getAttribute("aria-expanded"), "false");
    await assets.dispatchEvent("dragover", { dataTransfer: data });
    assert.equal(await assets.getAttribute("data-file-drop-target"), "");
    const screenshot = path.resolve(
      "test-results/sidebar-file-drop",
      `${engine}-folder-target.png`,
    );
    await mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    await assets.dispatchEvent("drop", { dataTransfer: data });
    await page
      .getByRole("treeitem", { name: "SENTINEL-image.bin", exact: true })
      .waitFor();
    assert.equal(await assets.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      await readFile(
        path.join(
          fixture.repositorySeed.repository,
          "assets/SENTINEL-image.bin",
        ),
      ),
      binary,
    );
    await data.dispose();

    data = await transfer([
      ["SENTINEL-empty", Buffer.alloc(0)],
      ["SENTINEL-batch.txt", Buffer.from("batch")],
    ]);
    await tree.dispatchEvent("drop", { dataTransfer: data });
    await page
      .getByRole("treeitem", { name: "SENTINEL-batch.txt", exact: true })
      .waitFor();
    assert.equal(
      (
        await readFile(
          path.join(fixture.repositorySeed.repository, "SENTINEL-empty"),
        )
      ).length,
      0,
    );
    assert.equal(
      await readFile(
        path.join(fixture.repositorySeed.repository, "SENTINEL-batch.txt"),
        "utf8",
      ),
      "batch",
    );
    await data.dispose();

    data = await transfer([["SENTINEL-drop.txt", Buffer.from("replacement")]]);
    await tree.dispatchEvent("drop", { dataTransfer: data });
    await page
      .getByRole("alert")
      .filter({ hasText: "already exists" })
      .waitFor();
    assert.deepEqual(
      await readFile(
        path.join(fixture.repositorySeed.repository, "SENTINEL-drop.txt"),
      ),
      text,
    );
    await data.dispose();
    assert.deepEqual(errors, []);
    results.push({
      engine,
      status: "pass",
      rootText: true,
      nestedBinaryBytes: binary.length,
      multipleFiles: true,
      emptyFile: true,
      collisionPreserved: true,
      encryptedRelay: true,
      screenshot,
    });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
console.log(JSON.stringify({ results }, null, 2));
