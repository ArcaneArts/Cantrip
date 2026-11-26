import assert from "node:assert/strict";
import { actualCouncilModels } from "./actual-council-models.mjs";

export async function actualCouncilAppMode({
  page,
  result,
  appOrigin,
  workerId,
}) {
  const title = "Disposable Operations Agent";
  const renamed = "Release Operations";
  const modePicker = () =>
    page.getByRole("button", { name: /switch cantrip mode/iu }).first();
  const roster = () => page.getByRole("navigation", { name: "Council agents" });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const tooltip = (label) =>
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: label });
  const hoverTooltip = async (name, label = name, control = button(name)) => {
    assert.equal(await control.getAttribute("title"), null);
    const target = (await control.isDisabled())
      ? control.locator("xpath=..")
      : control;
    await target.hover();
    try {
      await tooltip(label).waitFor({ timeout: 5_000 });
    } catch (error) {
      const active = await page
        .locator('[data-slot="tooltip-content"]')
        .allTextContents();
      throw new Error(
        `Tooltip for ${label} did not open. Visible tooltips: ${active.join(", ")}`,
        { cause: error },
      );
    }
  };
  const enterCouncil = async () => {
    await modePicker().click();
    await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
    await roster().waitFor();
  };

  await page.setViewportSize({ width: 1344, height: 900 });
  await page.goto(appOrigin);
  try {
    await enterCouncil();
  } catch (error) {
    const content = (await page.locator("body").innerText()).slice(0, 1500);
    throw new Error(
      `Could not open Council through the app shell. Visible content: ${content}`,
      { cause: error },
    );
  }
  const aside = page.locator('[data-slot="app-sidebar"]');
  const footer = aside.getByRole("button", { name: "Open settings" });
  const [sidebarBounds, footerBounds] = await Promise.all([
    aside.boundingBox(),
    footer.boundingBox(),
  ]);
  assert.ok(sidebarBounds && footerBounds);
  assert.ok(
    sidebarBounds.y +
      sidebarBounds.height -
      (footerBounds.y + footerBounds.height) <
      28,
    "The Council footer stays at the bottom with a short roster.",
  );
  await hoverTooltip(
    "New agent",
    "New agent",
    roster().getByRole("button", { name: "New agent", exact: true }),
  );
  await roster().getByText("Preserve this Council role marker 🌲").waitFor();
  await hoverTooltip(title, `Open ${title}`);
  await button(title).click();
  await page.getByRole("heading", { name: title }).waitFor();
  assert.equal(await button("Send prompt").isDisabled(), true);
  for (const name of [
    "Search Council history",
    "Edit fast memory",
    "Open agent files",
    "Send prompt",
    "Council routines",
  ]) {
    await hoverTooltip(name);
  }
  await button("Search Council history").press("Tab");
  assert.equal(
    await button("Edit Council agent").evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  );
  await tooltip("Edit Council agent").waitFor();
  await page.keyboard.press("Enter");
  result.steps.push(
    "Council tooltips appear on hover, on disabled actions, and on keyboard focus",
  );
  const edit = page.getByRole("dialog", { name: "Edit Council agent" });
  await edit.locator("textarea:enabled").waitFor();
  assert.equal(await edit.getByLabel("Primary agent").isChecked(), true);
  assert.match(
    await edit.getByLabel("Role").inputValue(),
    /Preserve this Council role marker/u,
  );
  await edit.getByLabel("Name").fill(renamed);
  await edit.getByLabel("Role").fill("Release coordinator");
  await edit.getByLabel("Primary agent").uncheck();
  await edit.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();
  await roster()
    .getByRole("button", { name: renamed })
    .getByText("Release coordinator")
    .waitFor();

  await button("Council routines").click();
  const routines = page.getByRole("dialog", { name: "Council routines" });
  await routines.waitFor();
  await hoverTooltip("Close", "Close routines");
  await routines.getByRole("button", { name: "Close", exact: true }).click();
  await routines.waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Back to Council agents" }).click();
  await roster()
    .getByRole("button", { name: renamed })
    .getByText("Release coordinator")
    .waitFor();
  await roster().getByRole("button", { name: renamed }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();
  await modePicker().click();
  await page.getByRole("menuitem", { name: "Cantrip Chat" }).click();
  await modePicker().click();
  await page.getByRole("menuitem", { name: "Cantrip IDE" }).click();
  await modePicker().click();
  await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();
  result.steps.push(
    "Council mode opens from the browser shell at desktop and mobile widths",
  );
  await page.setViewportSize({ width: 1344, height: 900 });
  await actualCouncilModels({ page, result, workerId });
}

export async function actualCouncilDisabled({ page, result, appOrigin }) {
  const enabled = await page.evaluate(async () => {
    const { getServerBootstrap } = await import("/src/lib/api/account.ts");
    return Boolean((await getServerBootstrap()).capabilities.council);
  });
  assert.equal(enabled, false);
  await page.goto(appOrigin);
  const modePicker = page
    .getByRole("button", { name: /switch cantrip mode/iu })
    .first();
  await modePicker.click();
  await page.getByRole("menuitem", { name: "Cantrip Chat" }).waitFor();
  assert.equal(
    await page.getByRole("menuitem", { name: "Cantrip Council" }).count(),
    0,
  );
  await page.getByRole("menuitem", { name: "Cantrip Chat" }).click();
  await modePicker.click();
  await page.getByRole("menuitem", { name: "Cantrip IDE" }).click();
  await modePicker.click();
  await page.getByRole("menuitem", { name: "Cantrip Chat" }).waitFor();
  result.steps.push(
    "An explicit server opt-out hides Council and leaves Chat and IDE available.",
  );
}
