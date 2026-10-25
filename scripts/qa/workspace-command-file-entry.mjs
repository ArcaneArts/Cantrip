import assert from "node:assert/strict";

const tabs = (layout) =>
  layout.windows.flatMap((window) => window.panes.flatMap((pane) => pane.tabs));

/** Exercise the production command-bar search and file-open callback. */
export async function verifyCommandFileEntry({ desktop, mobile, record }) {
  const workspace = (page) =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const mobileBefore = await workspace(mobile);
  const before = await workspace(desktop);
  const opened = new Map();
  const open = async (name) => {
    await desktop.keyboard.press("Shift");
    await desktop.keyboard.press("Shift");
    const dialog = desktop.getByRole("dialog", { name: "Cantrip command bar" });
    await dialog.getByRole("combobox").fill(name);
    await dialog.getByRole("option").filter({ hasText: name }).click();
    const editor = desktop.getByRole("textbox", {
      name: `Edit ${name}`,
      exact: true,
    });
    await editor.waitFor();
    return editor;
  };
  for (const name of ["command-first.rs", "command-second.rs"]) {
    const editor = await open(name);
    const layout = await workspace(desktop);
    const active = layout.windows
      .flatMap((window) => window.panes)
      .flatMap((pane) => pane.tabs.filter((tab) => tab.id === pane.activeTabId))
      .find(
        (tab) =>
          tab.resource.definitionId === "project.file" &&
          !tabs(before).some((previous) => previous.id === tab.id) &&
          ![...opened.values()].includes(tab.id),
      );
    assert.ok(active, "Search result opens a distinct owned file tab");
    assert.equal(active.preview, false);
    opened.set(name, active.id);
    await editor.fill(`// Unsaved command-bar draft: ${name}\n`);
  }
  assert.equal(new Set(opened.values()).size, 2);
  const established = await workspace(desktop);
  for (const [name, id] of opened) {
    const editor = await open(name);
    assert.equal(
      await editor.inputValue(),
      `// Unsaved command-bar draft: ${name}\n`,
    );
    const layout = await workspace(desktop);
    assert.deepEqual(tabs(layout), tabs(established));
    assert.ok(
      layout.windows.some((window) =>
        window.panes.some((pane) => pane.activeTabId === id),
      ),
    );
  }
  assert.deepEqual(await workspace(mobile), mobileBefore);
  record(
    "desktop.command-bar-files",
    "Command-bar search opens distinct pinned file tabs, reopens their existing identities and unsaved drafts, and leaves mobile placement unchanged",
  );
  await desktop
    .getByRole("button", { name: "Open File History", exact: true })
    .click();
  const history = desktop.getByRole("dialog", {
    name: "File history and blame",
  });
  await history
    .getByRole("button", { name: /Seed file entry acceptance/ })
    .waitFor();
  await history.getByRole("button", { name: "compare", exact: true }).click();
  await history.getByRole("textbox", { name: "Base revision" }).fill("HEAD~1");
  await history.getByRole("textbox", { name: "Target revision" }).fill("HEAD");
  await history.getByRole("button", { name: "Compare", exact: true }).click();
  const withHistory = await workspace(desktop);
  await history.getByRole("button", { name: "Open file", exact: true }).click();
  await history.waitFor({ state: "hidden" });
  await desktop
    .getByRole("textbox", { name: "Edit command-second.rs", exact: true })
    .waitFor();
  const returned = await workspace(desktop);
  assert.deepEqual(tabs(returned), tabs(withHistory));
  assert.deepEqual(
    tabs(returned).filter(
      (tab) => tab.resource.definitionId === "project.file",
    ),
    tabs(established).filter(
      (tab) => tab.resource.definitionId === "project.file",
    ),
  );
  assert.equal(
    await desktop
      .getByRole("textbox", { name: "Edit command-second.rs", exact: true })
      .inputValue(),
    "// Unsaved command-bar draft: command-second.rs\n",
  );
  assert.deepEqual(await workspace(mobile), mobileBefore);
  record(
    "desktop.history-file-entry",
    "Opening the historical comparison's current file focuses its existing owned tab and preserves its unsaved draft and mobile layout",
  );
  await desktop
    .getByRole("treeitem", { name: "entry", exact: true })
    .click({ button: "right" });
  await desktop
    .getByRole("menuitem", { name: "Open in Graph", exact: true })
    .click();
  const graph = desktop.getByRole("application", {
    name: /^Repository graph for revision/,
  });
  await graph.waitFor();
  await graph.focus();
  await graph.press("Home");
  const announcement = desktop.locator(
    "[data-repository-graph-surface] [aria-live=polite]",
  );
  for (
    let index = 0;
    index < 40 &&
    !(await announcement.innerText()).startsWith(
      "Selected file entry/command-first.rs.",
    );
    index++
  )
    await graph.press("ArrowRight");
  assert.match(
    await announcement.innerText(),
    /^Selected file entry\/command-first\.rs\./,
  );
  const withGraph = await workspace(desktop);
  await graph.press("Enter");
  const graphFile = desktop.getByRole("textbox", {
    name: "Edit command-first.rs",
    exact: true,
  });
  await graphFile.waitFor();
  assert.equal(
    await graphFile.inputValue(),
    "// Unsaved command-bar draft: command-first.rs\n",
  );
  assert.deepEqual(tabs(await workspace(desktop)), tabs(withGraph));
  assert.deepEqual(await workspace(mobile), mobileBefore);
  record(
    "desktop.graph-file-entry",
    "Keyboard activation of a repository graph file reuses its existing tab and unsaved draft without changing mobile placement",
  );
}
