import assert from "node:assert/strict";

/** Removed checkout links must neither redirect to Primary nor fail silently. */
export async function verifyHistoricalFileEntry({ mobile, desktop, record }) {
  const workspace = (page) =>
    page.evaluate(() => window.__qaRepositoryFixture.workspace());
  const created = await mobile.evaluate(() =>
    window.__qaRepositoryFixture.createWorktree({
      name: "historical-links",
      mode: {
        type: "newBranch",
        branch: "qa/historical-links",
        startPoint: "HEAD",
      },
    }),
  );
  await mobile.waitForFunction(
    async (id) =>
      (await window.__qaRepositoryFixture.worktrees()).some(
        (tree) => tree.id === id && tree.lifecycleState === "ready",
      ),
    created.id,
  );
  const historical = await mobile.evaluate(
    async (id) =>
      (await window.__qaRepositoryFixture.worktrees()).find(
        (tree) => tree.id === id,
      ),
    created.id,
  );
  assert.ok(
    historical.path && historical.path !== "Protected path unavailable",
  );
  const removed = await mobile.evaluate(
    (id) => window.__qaRepositoryFixture.removeWorktree(id),
    historical.id,
  );
  assert.equal(removed.lifecycleState, "missing");
  await mobile.evaluate(
    (tree) => window.__qaRepositoryFixture.seedFileLinkChat(tree),
    historical,
  );
  await mobile
    .getByRole("button", { name: "Choose project tab", exact: true })
    .click();
  await mobile
    .getByRole("region", { name: "Open views", exact: true })
    .getByRole("button", { name: "Open File link QA", exact: true })
    .last()
    .click();
  await mobile
    .getByRole("link", { name: "Historical relative file", exact: true })
    .waitFor();
  const mobileBefore = await workspace(mobile);
  const desktopBefore = await workspace(desktop);
  for (const label of [
    "Historical relative file",
    "Historical absolute file",
  ]) {
    await mobile.getByRole("link", { name: label, exact: true }).click();
    await mobile
      .getByText("Could not open file link", { exact: true })
      .waitFor();
    assert.deepEqual(await workspace(mobile), mobileBefore);
    assert.deepEqual(await workspace(desktop), desktopBefore);
    await mobile
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .click();
  }
  record(
    "mobile.removed-checkout-links",
    "Relative and absolute historical links report failure without opening Primary files or changing either workspace",
  );
}
