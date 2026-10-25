import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const tabs = (layout) =>
  layout.windows.flatMap((w) => w.panes.flatMap((p) => p.tabs));
const workspace = (page) =>
  page.evaluate(() => window.__qaRepositoryFixture.workspace());

export async function seedChatLinkFiles(repository) {
  for (const name of ["chat-relative.rs", "chat-absolute.rs"])
    await writeFile(path.join(repository, name), `// ${name}\nfn main() {}\n`);
}

/** Real transcript controls -> production chat routing -> worker -> owned tabs. */
export async function verifyChatFileEntry({ mobile, desktop, record }) {
  const desktopBefore = await workspace(desktop);
  const chat = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.seedFileLinkChat(),
  );
  const selectChat = async () => {
    await mobile
      .getByRole("button", { name: "Choose project tab", exact: true })
      .click();
    await mobile
      .getByRole("region", { name: "Open views", exact: true })
      .getByRole("button", { name: "Open File link QA", exact: true })
      .click();
    await mobile
      .getByRole("link", { name: "Relative QA file", exact: true })
      .waitFor();
  };
  await selectChat();
  const before = await workspace(mobile);
  const opened = new Map();
  for (const [name, label] of [
    ["chat-relative.rs", "Relative QA file"],
    ["chat-absolute.rs", "Absolute QA file"],
  ]) {
    await mobile.getByRole("link", { name: label, exact: true }).click();
    const editor = mobile.getByRole("textbox", {
      name: `Edit ${name}`,
      exact: true,
    });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), `// ${name}\nfn main() {}\n`);
    const layout = await workspace(mobile);
    const added = tabs(layout).filter(
      (tab) =>
        !tabs(before).some((old) => old.id === tab.id) &&
        ![...opened.values()].includes(tab.id),
    );
    assert.equal(added.length, 1);
    assert.equal(added[0].resource.definitionId, "project.file");
    assert.equal(added[0].preview, false);
    opened.set(name, added[0].id);
    await editor.fill(`// unsaved ${name}\n`);
    await selectChat();
  }
  const established = await workspace(mobile);
  for (const [name, tabId] of opened) {
    const summary = mobile.locator('[data-slot="message-file-summary"]');
    const file = summary
      .locator('[data-file-kind="file"]')
      .filter({ hasText: name });
    // Metadata may flatten absolute/relative paths to one checkout root. If it
    // is unavailable, navigate the actual fallback tree rather than bypassing it.
    for (let depth = 0; !(await file.count()) && depth < 30; depth++) {
      const folder = summary
        .locator('[data-file-kind="directory"][aria-expanded="false"]')
        .first();
      if (!(await folder.count())) break;
      await folder.click();
    }
    await file.click();
    const editor = mobile.getByRole("textbox", {
      name: `Edit ${name}`,
      exact: true,
    });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), `// unsaved ${name}\n`);
    const layout = await workspace(mobile);
    assert.deepEqual(
      tabs(layout).map((tab) => tab.id),
      tabs(established).map((tab) => tab.id),
    );
    assert.ok(
      layout.windows.some((w) => w.panes.some((p) => p.activeTabId === tabId)),
    );
    assert.ok(tabs(layout).some((tab) => tab.id === chat.tabId));
    await selectChat();
  }
  assert.deepEqual(await workspace(desktop), desktopBefore);
  record(
    "mobile.chat-file-entry",
    "Relative and absolute Markdown links open distinct pinned Edit tabs; related-file controls reuse both IDs and unsaved drafts; desktop layout unchanged",
  );
}
