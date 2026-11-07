import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { damageColdStopCheckpoint } from "./cold-suspension-stop.mjs";
import { eventually } from "./full-worker.mjs";
import { openMountedSuspensionChat } from "./mounted-suspension-browser.mjs";

/** Retain the real acknowledged bytes before injecting a restoration failure. */
export async function damageSuspensionForRetry(workerData, active, mode) {
  const name =
    createHash("sha256").update(active.threadId).digest("hex") + ".json";
  const files = [];
  for await (const file of glob(`**/turn-suspensions/${name}`, {
    cwd: workerData,
  }))
    files.push(path.join(workerData, file));
  assert.equal(files.length, 1);
  const file = files[0];
  const saved = await readFile(file);
  await damageColdStopCheckpoint(workerData, active, mode);
  return { file, saved, damaged: await checkpointBytes(file), mode };
}

async function checkpointBytes(file) {
  return readFile(file).catch((error) => {
    assert.equal(error.code, "ENOENT");
    return null;
  });
}

/** A real failed Resume must survive browser reload and permit explicit retry.
 * This repairs only the fixture's damaged bytes; production never repairs them. */
export async function qualifySuspensionRestoreFailure({
  page,
  origin,
  chatId,
  identity,
  active,
  inferences,
  mounted,
  damage,
}) {
  const count = inferences();
  let failure;
  if (mounted) {
    const reply = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/chats/${chatId}/pause` &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: /^Resume( automatic agent work| turn)?$/ })
      .click();
    const response = await reply;
    failure = { status: response.status(), body: await response.json() };
  } else {
    failure = await page.evaluate(async (id) => {
      try {
        return {
          body: await (
            await import("/src/lib/api/chats.ts")
          ).setChatPaused(id, false),
        };
      } catch (error) {
        return { status: error.status, body: { message: error.message } };
      }
    }, chatId);
  }
  assert.equal(failure.status, 502, JSON.stringify(failure));
  const held = await eventually(identity, (value) => {
    assert.equal(value.automationPaused, true);
    assert.equal(value.nativeSuspension.phase, "error");
    assert.equal(value.nativeSuspension.action, "resume");
    assert.equal(value.nativeSuspension.resumable, true);
    assert.deepEqual(value.nativeSuspension.active, active);
  });
  assert.equal(
    held.nativeSuspension.error?.code,
    `checkpoint-${damage.mode === "previous-runtime" ? "incompatible" : damage.mode}`,
    "The actual restoration failure must retain an actionable public category",
  );
  let text;
  if (mounted) {
    // A full reload discards optimistic/local UI state.
    await openMountedSuspensionChat(page, origin, null);
    const retry = page.getByRole("button", {
      name: "Retry resume",
      exact: true,
    });
    await retry.waitFor({ state: "visible" });
    assert.equal(await retry.isEnabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Stop current operation", exact: true })
        .isEnabled(),
      true,
    );
    await page
      .getByRole("status")
      .filter({ hasText: "Paused · resume failed" })
      .waitFor({ state: "visible" });
    const alert = page.getByRole("alert").filter({ hasText: /saved|paused/i });
    await alert.waitFor({ state: "visible" });
    text = await alert.innerText();
  }
  await delay(300);
  assert.equal(inferences(), count, "Failed Resume and reopening stay idle");
  assert.deepEqual(
    await checkpointBytes(damage.file),
    damage.damaged,
    "Failed Resume must retain the actual damaged/unsupported checkpoint",
  );
  await writeFile(damage.file, damage.saved);
  return {
    mode: damage.mode,
    status: failure.status,
    error: held.nativeSuspension.error,
    mountedError: text,
    retainedEvidence: true,
    idleAfterReload: true,
  };
}
