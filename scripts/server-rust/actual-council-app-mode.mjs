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
  await roster().getByText("Preserve this Council role marker 🌲").waitFor();
  await roster()
    .getByRole("button", { name: /Disposable Operations Agent/u })
    .click();
  await page.getByRole("heading", { name: title }).waitFor();
  await page.getByRole("button", { name: "Edit Council agent" }).click();
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
