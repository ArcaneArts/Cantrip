import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const names = Array.from(
  { length: 6 },
  (_, index) => `overflow-${index + 1}.rs`,
);
const tabs = (layout) =>
  layout.windows.flatMap((w) => w.panes.flatMap((p) => p.tabs));
const membership = (layout) => tabs(layout).map((tab) => tab.id);

export async function seedMobileOverflowFiles(repository) {
  await Promise.all(
    names.map((name) =>
      writeFile(path.join(repository, name), "fn main() {}\n"),
    ),
  );
}

/** Exercise real controls and authoritative layouts, not a synthetic navigation model. */
export async function verifyMobileOverflow({
  mobile,
  desktop,
  desktopBefore,
  record,
}) {
  const workspace = () =>
    mobile.evaluate(() => window.__qaRepositoryFixture.workspace());
  const picker = () =>
    mobile
      .getByRole("button", { name: "Choose project tab", exact: true })
      .click();
  const closePicker = () =>
    mobile
      .getByRole("button", { name: "Close project tabs", exact: true })
      .click();
  const openFromTree = async (name) => {
    await mobile
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await mobile.getByRole("treeitem", { name, exact: true }).click();
  };
  const before = await workspace();
  for (const name of names) {
    await openFromTree(name);
    await mobile
      .getByRole("textbox", { name: `Edit ${name}`, exact: true })
      .waitFor();
    await picker();
    const keep = mobile.getByRole("button", {
      name: `Keep ${name} open`,
      exact: true,
    });
    await keep.click();
    await keep.waitFor({ state: "hidden" });
    await closePicker();
  }
  const opened = await workspace();
  assert.equal(tabs(opened).length, tabs(before).length + names.length);
  const navigation = mobile.getByRole("navigation", {
    name: "Project navigation",
    exact: true,
  });
  assert.equal(await navigation.getAttribute("data-layout"), "scroll");
  assert.equal(
    await navigation.locator("[data-mobile-surface-tab]").count(),
    tabs(opened).length,
  );
  const dimensions = await navigation
    .locator(":scope > div")
    .evaluate((element) => ({
      viewport: element.clientWidth,
      content: element.scrollWidth,
    }));
  assert.ok(
    dimensions.content > dimensions.viewport,
    "Navigation really overflows its viewport",
  );
  await picker();
  const openViews = mobile.getByRole("region", {
    name: "Open views",
    exact: true,
  });
  for (const name of ["qa.txt", ...names]) {
    assert.equal(
      await openViews
        .getByRole("button", { name: `Open ${name}`, exact: true })
        .count(),
      1,
    );
  }
  const recent = mobile.getByRole("region", {
    name: "Recently used views",
    exact: true,
  });
  assert.deepEqual(
    await recent.getByRole("button").allTextContents(),
    names.slice(-5).reverse(),
  );
  await openViews
    .getByRole("button", { name: `Open ${names[0]}`, exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: `Edit ${names[0]}`, exact: true })
    .waitFor();
  await picker();
  assert.deepEqual(await recent.getByRole("button").allTextContents(), [
    names[0],
    ...names.slice(-4).reverse(),
  ]);
  assert.deepEqual(membership(await workspace()), membership(opened));
  await closePicker();
  record(
    "mobile.overflow-recent",
    "Seven distinct tabs remain reachable; scrolling and picker preserve membership, Recent is the five actual last activations",
  );

  await mobile.getByRole("button", { name: "Edit mode", exact: true }).click();
  await mobile.getByRole("menuitem", { name: "View", exact: true }).click();
  await mobile
    .getByRole("button", { name: "View mode", exact: true })
    .waitFor();
  await navigation
    .getByRole("button", { name: "Open qa.txt", exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: "Edit qa.txt", exact: true })
    .waitFor();
  await openFromTree(names[0]);
  await mobile
    .getByRole("button", { name: "View mode", exact: true })
    .waitFor();
  await mobile.reload();
  await mobile
    .getByRole("button", { name: "View mode", exact: true })
    .waitFor({ timeout: 30000 });
  assert.deepEqual(membership(await workspace()), membership(opened));
  record(
    "mobile.explicit-mode",
    "Explicit View survives selecting another file, reopening through Explorer and reload without duplicate tabs",
  );

  await picker();
  const middle = openViews.getByRole("button", {
    name: `Open ${names[2]}`,
    exact: true,
  });
  await middle.focus();
  await middle.press("Enter");
  await mobile
    .getByRole("textbox", { name: `Edit ${names[2]}`, exact: true })
    .waitFor();
  await picker();
  await mobile
    .getByRole("button", { name: `Close ${names[2]} view`, exact: true })
    .click();
  await closePicker();
  await mobile
    .getByRole("textbox", { name: `Edit ${names[3]}`, exact: true })
    .waitFor();
  assert.equal(tabs(await workspace()).length, tabs(opened).length - 1);
  await navigation
    .getByRole("button", { name: "Open qa.txt", exact: true })
    .click();
  assert.equal(
    await mobile
      .getByRole("textbox", { name: "Edit qa.txt", exact: true })
      .inputValue(),
    "Unsaved mobile-only draft\n",
  );
  assert.deepEqual(
    await desktop.evaluate(() => window.__qaRepositoryFixture.workspace()),
    desktopBefore,
  );
  record(
    "mobile.overflow-close-isolation",
    "Keyboard picker activation works; closing a middle active tab selects its right neighbor, preserving the original dirty draft and desktop layout",
  );
}
