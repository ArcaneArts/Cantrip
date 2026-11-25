import assert from "node:assert/strict";

export async function actualCouncilAppMode({ page, result, appOrigin }) {
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
  await edit.getByLabel("Primary agent").uncheck();
  await edit.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Back to Council agents" }).click();
  await roster().getByRole("button", { name: renamed }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();
  await modePicker().click();
  await page.getByRole("menuitem", { name: "Cantrip Chat" }).click();
  await modePicker().click();
  await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
  await page.getByRole("heading", { name: renamed }).waitFor();
  result.steps.push(
    "Council mode opens from the browser shell at desktop and mobile widths",
  );
}
