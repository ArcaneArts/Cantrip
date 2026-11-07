import assert from "node:assert/strict";

/** Reopen the real application after losing the worker and browser RAM state.
 * Setup uses the existing SDK; selecting the chat and Resume use actual DOM. */
export async function openMountedSuspensionChat(page, origin, paused = true) {
  const compact = process.argv.includes("--compact-controls");
  // Sidebar setup stays shared with the desktop fixture; all chat controls
  // below are exercised at the actual compact viewport when requested.
  if (compact) await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('input[type="password"]') ||
        document.body.innerText.includes("Durable suspension project"),
    );
  } catch (error) {
    // Report the real boot-module failure after the mounted app has failed.
    // Normal runs use the app's startup and never depend on this diagnostic.
    const diagnostic = await page.evaluate(async () => {
      try {
        await import("/src/lib/server-connections.ts");
        await import("/src/components/auth/application-session.tsx");
        return document.body.innerText;
      } catch (error) {
        return error.stack ?? error.message;
      }
    });
    throw new Error(`Mounted app did not boot: ${diagnostic}`, {
      cause: error,
    });
  }
  if (await page.locator('input[type="password"]').isVisible()) {
    const email = page.getByLabel("Email", { exact: true });
    if (await email.isVisible()) await email.fill("suspension@example.invalid");
    await page
      .getByLabel("Password", { exact: true })
      .fill("isolated durable suspension password");
    await page
      .locator("form")
      .filter({ has: page.locator('input[type="password"]') })
      .locator('button[type="submit"]')
      .click();
  }
  await page
    .getByText("Durable suspension project", { exact: true })
    .first()
    .click();
  const projectOption = page
    .locator('[data-slot="project-switcher-project"]')
    .filter({ hasText: "Durable suspension project" });
  if (await projectOption.isVisible()) await projectOption.click();
  await page
    .getByText(/^Chats$/i)
    .first()
    .click();
  await page.getByText("Durable suspension", { exact: true }).first().click();
  if (compact) await page.setViewportSize({ width: 390, height: 844 });
  if (paused === null) return { text: await page.locator("body").innerText() };
  const resume = page.getByRole("button", {
    name: paused ? /^Resume( automatic agent work| turn)?$/ : "Pause agent",
  });
  await resume.waitFor({ state: "visible" });
  assert.equal(await resume.isEnabled(), true);
  if (paused)
    await page
      .getByRole("status")
      .filter({ hasText: /^Paused$/ })
      .waitFor({ state: "visible" });
  return {
    text: await page.locator("body").innerText(),
    viewport: page.viewportSize(),
  };
}

export async function clickMountedSuspensionPause(page, chatId) {
  const reply = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chats/" + chatId + "/pause" &&
      response.request().method() === "PATCH",
  );
  void reply.catch(() => {});
  await page.getByRole("button", { name: "Pause agent" }).click();
  const response = await reply;
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

export async function clickMountedSuspensionResume(page, chatId) {
  const reply = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chats/" + chatId + "/pause" &&
      response.request().method() === "PATCH",
  );
  void reply.catch(() => {});
  await page
    .getByRole("button", {
      name: /^(Resume( automatic agent work| turn)?|Retry resume)$/,
    })
    .click();
  const response = await reply;
  assert.equal(response.status(), 200, await response.text());
  return [await response.json()];
}
