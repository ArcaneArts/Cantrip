import assert from "node:assert/strict";

export async function actualCouncilBrowserHistory({
  page,
  appOrigin,
  serverOrigin,
  stopWorker,
  chatId,
  workerId,
  source,
  nearby,
  result,
}) {
  await page.setViewportSize({ width: 1344, height: 900 });
  await page.goto(appOrigin);
  await page
    .getByRole("button", { name: /switch cantrip mode/iu })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
  await page
    .getByRole("navigation", { name: "Council agents" })
    .getByRole("button", { name: /Disposable Operations Agent/u })
    .click();
  await page.getByRole("button", { name: "Search Council history" }).click();
  const dialog = page.getByRole("dialog", { name: "Council history" });
  const unauthorized = await fetch(
    new URL("/api/internal/council-history/source", serverOrigin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: chatId,
        workerId,
        source: { kind: "head" },
      }),
    },
  );
  assert.equal(unauthorized.status, 401);
  await dialog
    .getByRole("textbox", { name: "Search Council history" })
    .fill(source.text);
  await dialog.getByRole("checkbox", { name: "Exact phrase" }).check();
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/council/agents/${chatId}/history/search`,
  );
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const reply = await pending;
  assert.equal(reply.status(), 200, await reply.text());
  const request = reply.request().postDataJSON();
  const response = await reply.json();
  assert.equal(request.requestId, response.requestId);
  assert.ok(request.protectedQuery.ciphertext);
  assert.ok(response.protectedResult.ciphertext);
  assert.ok(!JSON.stringify([request, response]).includes(source.text));
  await dialog
    .getByRole("button", { name: new RegExp(source.text, "u") })
    .click();
  await dialog
    .getByRole("article", { name: "Selected message" })
    .getByText(source.text, { exact: true })
    .waitFor();
  await dialog
    .getByRole("article", { name: "Nearby message" })
    .getByText(nearby, { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "Back to search" }).click();
  await dialog
    .getByRole("textbox", { name: "Search Council history" })
    .fill("no-such-council-evidence-38b016fe");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog.getByText("No matching messages.", { exact: true }).waitFor();

  await stopWorker();
  await page.setViewportSize({ width: 390, height: 844 });
  const sourceLink = new URL(
    `/?${new URLSearchParams({ councilAgent: chatId, message: source.id })}`,
    appOrigin,
  );
  await page.goto(sourceLink.href);
  await dialog
    .getByRole("article", { name: "Selected message" })
    .getByText(source.text, { exact: true })
    .waitFor();
  await dialog
    .getByRole("article", { name: "Nearby message" })
    .getByText(nearby, { exact: true })
    .waitFor();
  result.councilBrowserHistory = {
    chatId,
    messageId: source.id,
    desktopSearch: true,
    sealedExchange: true,
    offlineMobileLink: true,
  };
  result.steps.push(
    "Council browser search used the idle worker and a narrow-layout source link opened retained evidence with the worker stopped",
  );
}
