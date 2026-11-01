import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";

const engine = process.argv[2] ?? "chromium";
const browserType = { chromium, webkit }[engine];
if (!browserType) throw new Error("Expected chromium or webkit");
const evidence =
  process.env.CANTRIP_QA_EVIDENCE ?? "/tmp/cantrip-open-as-evidence";
await mkdir(evidence, { recursive: true });
const fixture = await startEditorRecoveryFixture({ repositoryProject: true });
const repository = fixture.repositorySeed.repository;
await mkdir(path.join(repository, "nested"));
const json = '{"enabled":true,"nested":{"value":42}}\n';
await Promise.all([
  writeFile(path.join(repository, "opaque.xyz"), json),
  writeFile(path.join(repository, "known.json"), json),
  writeFile(
    path.join(repository, "note.xyz"),
    "# Markdown override\n\nKnown content.\n",
  ),
  writeFile(path.join(repository, "readme.md"), "# Original heading\n"),
  writeFile(path.join(repository, "nested/child.xyz"), '{"nestedChild":123}'),
  writeFile(path.join(repository, "broken.xyz"), "not JSON"),
  writeFile(
    path.join(repository, "image.xyz"),
    await readFile(
      new URL("../../cantrip_app/src-tauri/icons/32x32.png", import.meta.url),
    ),
  ),
  writeFile(
    path.join(repository, "vector.xyz"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>',
  ),
]);
const results = [];
const record = (event, details) => {
  const result = { engine, event, status: "pass", details };
  results.push(result);
  console.log(JSON.stringify(result));
};
let browser, page;
try {
  browser = await browserType.launch({ headless: true });
  page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
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
  const workspace = () =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const currentTab = async () => {
    const layout = await workspace();
    const window = layout.windows.find((w) => w.id === layout.mainWindowId);
    const pane = window.panes.find((p) => p.id === window.focusedPaneId);
    return pane?.tabs.find((t) => t.id === pane.activeTabId);
  };
  const openAs = async (name, label, id) => {
    await file(name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open As", exact: true }).hover();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await page.waitForFunction(async (viewer) => {
      const layout = await window.__qaRepositoryFixture.workspace();
      return layout.windows.some((w) =>
        w.panes.some((p) =>
          p.tabs.some((t) => t.id === p.activeTabId && t.fileViewer === viewer),
        ),
      );
    }, id);
  };
  const editor = (name) =>
    page.getByRole("textbox", { name: `Edit ${name}`, exact: true });
  const structured = () =>
    page.getByRole("textbox", {
      name: "Search structured values",
      exact: true,
    });
  await file("opaque.xyz").click();
  await editor("opaque.xyz").waitFor();
  assert.equal(await editor("opaque.xyz").inputValue(), json);
  const initialTab = (await currentTab()).id;
  record(
    "unfamiliar-normal-open",
    "A real text file can open normally even when its extension is not recognized by the worker",
  );
  await openAs("opaque.xyz", "JSON", "json");
  await structured().waitFor();
  assert.equal(
    await page
      .getByRole("switch", { name: "Edit enabled", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  const jsonTab = (await currentTab()).id;
  assert.equal(jsonTab, initialTab);
  assert.equal(
    await readFile(path.join(repository, "opaque.xyz"), "utf8"),
    json,
  );
  record(
    "unknown-json",
    "An unfamiliar extension reaches the JSON visual parser through the real sidebar menu",
  );
  await page.reload();
  await structured().waitFor();
  assert.equal((await currentTab()).fileViewer, "json");
  record(
    "persisted-format",
    "Reload preserves the JSON override on the same file tab",
  );
  await openAs("opaque.xyz", "Automatic", null);
  await editor("opaque.xyz").waitFor();
  assert.equal(await editor("opaque.xyz").inputValue(), json);
  assert.equal((await currentTab()).id, jsonTab);
  record(
    "automatic-reset",
    "Automatic restores the normal source editor without adding a duplicate tab",
  );
  await openAs("known.json", "Text", "text");
  await editor("known.json").waitFor();
  await file("known.json").click();
  await editor("known.json").waitFor();
  assert.equal((await currentTab()).fileViewer, "text");
  record(
    "normal-open-preserves",
    "A normal sidebar click keeps an existing explicit viewer choice",
  );
  await openAs("note.xyz", "Markdown", "markdown");
  await page
    .getByRole("heading", { name: "Markdown override", exact: true })
    .waitFor();
  record(
    "unknown-markdown",
    "An unfamiliar extension renders as Markdown when explicitly chosen",
  );
  await file("nested").click();
  await openAs("child.xyz", "JSON", "json");
  await structured().waitFor();
  await page
    .getByRole("textbox", { name: "Edit nestedChild", exact: true })
    .waitFor();
  record(
    "nested-file",
    "Open As is available for files inside expanded folders",
  );
  await openAs("readme.md", "Text", "text");
  await editor("readme.md").waitFor();
  assert.equal(await editor("readme.md").inputValue(), "# Original heading\n");
  await editor("readme.md").fill("# Unsaved heading\n");
  await openAs("readme.md", "Markdown", "markdown");
  await page
    .getByRole("heading", { name: "Unsaved heading", exact: true })
    .waitFor();
  await openAs("readme.md", "Text", "text");
  assert.equal(await editor("readme.md").inputValue(), "# Unsaved heading\n");
  assert.equal(
    await readFile(path.join(repository, "readme.md"), "utf8"),
    "# Original heading\n",
  );
  record(
    "dirty-buffer",
    "Switching Text/Markdown preserves the unsaved buffer and does not rewrite the file",
  );
  await openAs("image.xyz", "Image", "image");
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="image.xyz"]');
    return image?.naturalWidth === 32;
  });
  record(
    "unknown-image",
    "Protected media reads and image decoding work for a PNG named .xyz",
  );
  await openAs("vector.xyz", "Image", "image");
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="vector.xyz"]');
    return image?.naturalWidth === 64;
  });
  await page.screenshot({ path: path.join(evidence, `${engine}-image.png`) });
  record(
    "unknown-svg",
    "Forced Image detects the SVG MIME from bytes rather than the extension",
  );
  await openAs("broken.xyz", "JSON", "json");
  await page.getByText("Visual mode is unavailable", { exact: true }).waitFor();
  assert.equal(
    await readFile(path.join(repository, "broken.xyz"), "utf8"),
    "not JSON",
  );
  await openAs("broken.xyz", "Text", "text");
  await editor("broken.xyz").waitFor();
  assert.equal(await editor("broken.xyz").inputValue(), "not JSON");
  record(
    "invalid-format-recovery",
    "Invalid JSON reports its parse failure and can be reopened as Text",
  );
  await writeFile(
    path.join(evidence, `${engine}.json`),
    JSON.stringify({ results, layout: await workspace() }, null, 2),
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
