import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { coldSuspensionStop } from "./cold-suspension-stop.mjs";
import { eventually } from "./full-worker.mjs";
import {
  suspensionChat,
  steerSuspensionChat,
} from "./durable-suspension-browser.mjs";
import { completeSuspensionSession } from "./suspension-terminal-resource.mjs";
import {
  openMountedSuspensionChat,
  clickMountedSuspensionResume,
} from "./mounted-suspension-browser.mjs";

/** Try actual capture with a live command, then recover the surviving turn. */
export async function refuseActiveSuspensionSession({
  page,
  chatId,
  projectId,
  origin,
  workerData,
  directory,
  session,
  boundary,
  model,
  inferences,
  configuration,
  stopActive = false,
}) {
  await openMountedSuspensionChat(page, origin, false);
  const count = inferences();
  const reply = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/chats/${chatId}/pause` &&
      response.request().method() === "PATCH",
  );
  void reply.catch(() => {});
  await page.getByRole("button", { name: "Pause agent" }).click();
  const identity = () => suspensionChat(page, projectId, chatId);
  await eventually(identity, (value) =>
    assert.equal(value.nativeSuspension.phase, "pausing"),
  );
  const pendingInput = "DURABLE_RESOURCE_PENDING";
  assert.equal(
    (await steerSuspensionChat(page, chatId, configuration, pendingInput))
      .steered,
    true,
  );
  boundary.release();
  const response = await reply;
  session.refusal = {
    status: response.status(),
    body: await response.text(),
    pendingInput,
  };
  const failed = await eventually(identity, (value) => {
    assert.equal(value.nativeSuspension.phase, "error");
    assert.equal(value.nativeSuspension.action, "pause");
    assert.equal(value.nativeSuspension.resumable, false);
  });
  session.refusal.suspension = failed.nativeSuspension;
  assert.equal(inferences(), count);
  const checkpoints = [];
  for await (const file of glob("**/turn-suspensions/*.json", {
    cwd: workerData,
  }))
    checkpoints.push(file);
  assert.equal(
    checkpoints.length,
    0,
    "An active command receives no committed checkpoint",
  );
  for (const name of [
    "Retry pause",
    "Resume automatic agent work",
    "Stop current operation",
  ])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isEnabled(),
      true,
    );
  session.refusal.uiText = await page.locator("body").innerText();
  assert.match(
    session.refusal.uiText,
    /background commands.*finish|command output producers.*close/i,
  );
  if (stopActive) {
    const pid = Number(
      (
        await readFile(path.join(directory, "durable-session-pid"), "utf8")
      ).trim(),
    );
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    session.refusal.stopped = await coldSuspensionStop({
      page,
      chatId,
      identity,
      workerData,
      active: failed.nativeSuspension.active,
      inferences,
      mounted: true,
    });
    // Stop ends the native turn. A yielded command is a thread-owned resource
    // and may survive that turn; record its actual state before tree shutdown.
    try {
      session.refusal.commandStateAfterStop = (
        await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="])
      ).stdout.trim();
    } catch (error) {
      if (error.code !== 1) throw error;
      session.refusal.commandStateAfterStop = "absent";
    }
    await assert.rejects(
      readFile(path.join(directory, "durable-session-complete")),
      { code: "ENOENT" },
    );
    return null;
  }
  await completeSuspensionSession(directory);
  assert.equal(
    inferences(),
    count,
    "Command completion does not release the paused turn",
  );
  const retry = model.reply({
    text: "DURABLE_RESOURCE_RETRY_BOUNDARY",
    hold: true,
  });
  const resumed = await clickMountedSuspensionResume(page, chatId);
  assert.ok(resumed.every((value) => value.paused === false));
  await eventually(
    () => retry.entered,
    (value) => assert.equal(value, true),
  );
  session.refusal.liveResumed = true;
  return retry;
}
