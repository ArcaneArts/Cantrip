import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyCantripOsDesktop({
  call,
  os,
  workspaceUrl,
  guestWorkspaceId,
  observeGuest,
  journalDir,
  stopWorker,
  startWorker,
}) {
  const workspace = (await call("GET", workspaceUrl)).find(
    (entry) => entry.guestWorkspaceId === guestWorkspaceId,
  );
  assert.ok(workspace, "Core recorded the guest workspace");
  const base = workspaceUrl + "/" + workspace.id;
  const operations = base + "/desktop-operations";

  const submissions = [];
  for (const action of ["start", "restart", "stop"]) {
    const before = await observeGuest();
    const status = await call("GET", base + "/desktop");
    assert.equal(
      status.observation?.status,
      before.status,
      JSON.stringify(status),
    );
    const request = {
      operationId: randomUUID(),
      action,
      runtimeGeneration: os.runtimeGeneration,
      attachmentGeneration: os.attachmentGeneration,
      targetGeneration: status.target.generation,
    };
    const completed = await call("POST", operations, request);
    assert.equal(completed.state, "ready", JSON.stringify(completed));
    assert.equal(completed.completionEvidence, "acknowledged-and-observed");
    const after = await observeGuest();
    assert.equal(after.status, action === "stop" ? "stopped" : "running");
    if (action === "stop") {
      assert.equal(after.generation, before.generation);
    } else {
      assert.ok(after.generation > before.generation);
      assert.notEqual(after.desktop_generation, before.desktop_generation);
    }
    assert.equal((await call("POST", operations, request)).state, "ready");
    assert.deepEqual(await observeGuest(), after);
    submissions.push({ request, before, after });
  }

  const [, restart, stop] = submissions;
  const restartFile = path.join(
    journalDir,
    restart.request.operationId + ".json",
  );
  const stopFile = path.join(journalDir, stop.request.operationId + ".json");
  const record = JSON.parse(await readFile(restartFile, "utf8"));
  assert.equal(
    record.checkpoint.guest.request.operation_id,
    restart.request.operationId,
  );
  assert.deepEqual(record.checkpoint.guest.receipt.after, restart.after);
  const fields = [
    "serverId",
    "ownerId",
    "workerId",
    "instanceId",
    "guestInstanceId",
    "attachmentGeneration",
    "runtimeGeneration",
    "workspaceId",
    "guestWorkspaceId",
    "uid",
    "gid",
    "homeGuestPath",
  ];
  assert.equal(
    record.checkpoint.guest.request.scope_key,
    createHash("sha256")
      .update(
        JSON.stringify([
          ...fields.map((field) => record.scope[field]),
          restart.request.targetGeneration,
        ]),
      )
      .digest("hex"),
  );

  // Preserve the guest's real receipts while restoring the worker journal to
  // its last write before the receipt. Also exercise the guest-only read path.
  await stopWorker();
  record.state = "running";
  record.receipt = null;
  delete record.checkpoint.guest;
  await writeFile(restartFile, JSON.stringify(record) + "\n");
  await unlink(stopFile);
  await startWorker();

  for (const { request } of [restart, stop]) {
    const observed = await call(
      "POST",
      operations + "/" + request.operationId + "/observe",
    );
    assert.equal(observed.state, "ready", JSON.stringify(observed));
    assert.equal(observed.completionEvidence, "acknowledged-and-observed");
  }
  const recovered = JSON.parse(await readFile(restartFile, "utf8"));
  assert.equal(recovered.state, "ready");
  assert.deepEqual(recovered.receipt.before, restart.before);
  assert.deepEqual(recovered.receipt.after, restart.after);
  await assert.rejects(readFile(stopFile), { code: "ENOENT" });
  assert.deepEqual(await observeGuest(), stop.after);
}
