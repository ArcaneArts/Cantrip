import assert from "node:assert/strict";

const tabs = (layout) =>
  layout.windows.flatMap((window) => window.panes.flatMap((pane) => pane.tabs));

/** Full Explorer, not the sidebar tree: exercise the non-native opening route. */
export async function verifyExplorerEntry({ mobile, desktop, record }) {
  const workspace = (page) =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const desktopBefore = await workspace(desktop);
  const before = await workspace(mobile);
  // A null selected path seeds an ordinary Explorer, with no legacy document.
  const explorer = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.seedLegacyFile(null),
  );
  const selectExplorer = async () => {
    await mobile
      .getByRole("button", { name: "Choose project tab", exact: true })
      .click();
    await mobile
      .getByRole("region", { name: "Open views", exact: true })
      .getByRole("button", { name: "Open Legacy migration QA", exact: true })
      .click();
    await mobile
      .getByRole("treeitem", { name: /^unknown\.cantrip-source/ })
      .waitFor();
  };
  await selectExplorer();
  const opened = new Map();
  for (const name of ["unknown.cantrip-source", "second.txt"]) {
    await mobile
      .getByRole("treeitem", {
        name: new RegExp(`^${name.replaceAll(".", "\\.")}`),
      })
      .click();
    await mobile
      .getByRole("textbox", { name: `Edit ${name}`, exact: true })
      .waitFor();
    const layout = await workspace(mobile);
    const active = layout.windows
      .flatMap((window) => window.panes)
      .flatMap((pane) => pane.tabs.filter((tab) => tab.id === pane.activeTabId))
      .find(
        (tab) =>
          tab.resource.definitionId === "project.file" &&
          !tabs(before).some((previous) => previous.id === tab.id),
      );
    assert.ok(active, "Explorer creates a distinct owned file view");
    assert.equal(active.preview, false);
    opened.set(name, active.id);
    assert.ok(
      tabs(layout).some(
        (tab) =>
          tab.id === explorer.tabId &&
          tab.resource.definitionId === "project.explorer",
      ),
      "Explorer remains a directory view",
    );
    await selectExplorer();
  }
  assert.equal(new Set(opened.values()).size, 2);
  const established = await workspace(mobile);
  await mobile
    .getByRole("treeitem", { name: /^unknown\.cantrip-source/ })
    .click();
  await mobile
    .getByRole("textbox", { name: "Edit unknown.cantrip-source", exact: true })
    .waitFor();
  const reopened = await workspace(mobile);
  assert.deepEqual(
    tabs(reopened).map((tab) => tab.id),
    tabs(established).map((tab) => tab.id),
  );
  assert.ok(
    reopened.windows.some((window) =>
      window.panes.some(
        (pane) => pane.activeTabId === opened.get("unknown.cantrip-source"),
      ),
    ),
  );
  assert.deepEqual(await workspace(desktop), desktopBefore);
  record(
    "mobile.full-explorer-files",
    "Full Explorer opens two distinct pinned file views; reopening focuses the existing tab and desktop layout stays unchanged",
  );
}
