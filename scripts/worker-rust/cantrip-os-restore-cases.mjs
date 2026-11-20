import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "../../packages/crypto/dist/index.js";

export async function verifyCantripOsRecovery({
  call,
  workerId,
  data,
  serverId,
  os,
  workspaceUrl,
  storageKey,
  docker,
  container,
  startWorker,
  crashWorker,
  context,
  componentKey,
  marker,
  source,
  metadata,
  recoveryTrace,
  dropRecovery,
}) {
  const targetName = "restore-target";
  const base = "/api/cantrip-os";
  const placement = async () => {
    const { instance } = await call(
      "POST",
      base + "/" + os.id + "/refresh",
      {},
    );
    assert.equal(instance.attachmentGeneration, os.attachmentGeneration);
    return {
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    };
  };
  const create = await call("POST", workspaceUrl, {
    operationId: randomUUID(),
    guestWorkspaceId: targetName,
    ...(await placement()),
  });
  assert.equal(create.state, "ready");
  const target = (await call("GET", workspaceUrl)).find(
    (workspace) => workspace.guestWorkspaceId === targetName,
  );
  assert.ok(target);
  const guest = (...args) => docker("exec", "--user", "0", container, ...args);
  const home = target.homeGuestPath;
  const write = (name, text) =>
    guest(
      "/bin/sh",
      "-c",
      'printf "%s" "$1" > "$2"',
      "--",
      text,
      home + "/" + name,
    );
  const inode = (file) => guest("stat", "-c", "%i", file);
  const originalText = "original retained home";
  await write("keep.txt", originalText);
  const original = await inode(home);
  const submit = (request) =>
    call("POST", base + "/" + os.id + "/backup-operations", request);
  const recover = async (request, mode) =>
    call(
      "POST",
      base + "/backup-operations/" + request.operationId + "/recovery",
      mode === "continue" ? { mode, ...(await placement()) } : { mode },
    );
  const identity = (operationId) => ({
    ownerId: os.ownerId,
    serverId,
    operationId,
    componentKey,
    keyRevision: 1,
  });
  const request = async (intent) => {
    const operationId = randomUUID();
    const { paths: _privatePaths, ...publicIntent } = intent;
    return {
      operationId,
      workspaceId: target.id,
      ...(await placement()),
      ...publicIntent,
      protectedRequest: await encryptCantripOsBackupMessage({
        ...identity(operationId),
        direction: "request",
        plaintext: Buffer.from(
          JSON.stringify({ ...intent, workspaceId: target.id }),
        ),
      }),
    };
  };
  const details = async (summary, action) => {
    assert.equal(
      summary.result.state,
      "ready",
      JSON.stringify(summary.result.error),
    );
    const bytes = await decryptCantripOsBackupMessage({
      ...identity(summary.operationId),
      direction: "response",
      frame: summary.result.protectedResult,
    });
    const info = JSON.parse(Buffer.from(bytes).toString("utf8"));
    assert.equal(info.action, action);
    return info.receipt;
  };
  const restoreIntent = {
    action: "restore",
    backupId: context.backupId,
    replace: true,
  };
  const staging = (admission) =>
    path.join(
      data,
      "cantrip-os-backups",
      storageKey,
      admission.operationId,
      "restore-staging",
      "verified.tar",
    );

  const archive = await readFile(source);
  const corrupt = await request(restoreIntent);
  await writeFile(source, archive.subarray(0, archive.length - 10));
  try {
    const failed = await submit(corrupt);
    assert.equal(failed.result.state, "failed");
    assert.equal(failed.result.phase, "verifying");
    await assert.rejects(readFile(staging(corrupt)), { code: "ENOENT" });
    await assert.rejects(readFile(recoveryTrace), { code: "ENOENT" });
    assert.equal(await inode(home), original);
  } finally {
    await writeFile(source, archive);
  }

  const restore = await request(restoreIntent);
  await writeFile(dropRecovery, "receive " + restore.operationId);
  const lost = await submit(restore);
  assert.equal(lost.result.state, "unknown");
  assert.equal(lost.result.phase, "receiving");
  assert.equal(await inode(home), original);
  assert.equal(await guest("cat", home + "/keep.txt"), originalText);
  await unlink(dropRecovery);
  await crashWorker();
  await startWorker();
  const refreshed = await call(
    "POST",
    "/api/workers/" + workerId + "/encryption/refresh",
    {
      component: "repository-content",
      keyRevision: 1,
    },
  );
  assert.equal(refreshed.status.state, "ready");
  assert.equal((await recover(restore, "observe")).result.state, "unknown");
  assert.equal((await recover(restore, "recover")).result.state, "unknown");
  assert.equal(await inode(home), original);
  assert.equal(
    await readFile(recoveryTrace, "utf8"),
    "receive " + restore.operationId + "\n",
  );

  const restored = await recover(restore, "continue");
  const restoreReceipt = await details(restored, "restore");
  const restoredInode = await inode(home);
  assert.notEqual(restoredInode, original);
  assert.equal(await inode(restoreReceipt.retained_original_home), original);
  assert.equal(restoreReceipt.archive_sha256, metadata.archiveSha256);
  assert.equal(restoreReceipt.workspace.uid, target.uid);
  assert.equal(restoreReceipt.runtime_handles_restored, false);
  const proof = await guest("sha256sum", home + "/private-雪");
  assert.equal(
    proof.split(" ")[0],
    createHash("sha256").update(marker).digest("hex"),
  );
  await assert.rejects(readFile(staging(restore)), { code: "ENOENT" });
  assert.deepEqual((await submit(restore)).result, restored.result);

  const displaced = "preserve the displaced restored home";
  await write("post-restore.txt", displaced);
  const rollback = await request({
    action: "rollback",
    restoreOperationId: restore.operationId,
  });
  const rolled = await submit(rollback);
  const rollbackReceipt = await details(rolled, "rollback");
  assert.equal(await inode(home), original);
  assert.equal(
    await inode(rollbackReceipt.retained_replaced_home),
    restoredInode,
  );
  assert.equal(
    await guest(
      "cat",
      rollbackReceipt.retained_replaced_home + "/post-restore.txt",
    ),
    displaced,
  );
  assert.deepEqual((await recover(rollback, "observe")).result, rolled.result);

  const filename = "reset-雪.txt";
  const selectedText = "selected reset payload";
  await write(filename, selectedText);
  const reset = await request({ action: "reset", paths: [filename] });
  await writeFile(dropRecovery, "reset " + reset.operationId);
  const resetLost = await submit(reset);
  assert.equal(resetLost.result.state, "unknown");
  await unlink(dropRecovery);
  const cleared = await recover(reset, "observe");
  const resetReceipt = await details(cleared, "reset");
  assert.deepEqual(resetReceipt.reset_paths, [filename]);
  assert.equal(resetReceipt.shared_system_state_changed, false);
  await guest("test", "!", "-e", home + "/" + filename);
  assert.equal(await guest("cat", home + "/keep.txt"), originalText);
  assert.equal(
    await guest("cat", resetReceipt.retained_original_home + "/" + filename),
    selectedText,
  );
  assert.deepEqual((await submit(reset)).result, cleared.result);
  const undo = await request({
    action: "rollback",
    restoreOperationId: reset.operationId,
  });
  await details(await submit(undo), "rollback");
  assert.equal(await inode(home), original);
  assert.equal(await guest("cat", home + "/" + filename), selectedText);
  assert.equal(
    await readFile(recoveryTrace, "utf8"),
    [
      "receive " + restore.operationId,
      "restore " + restore.operationId,
      "rollback " + rollback.operationId,
      "reset " + reset.operationId,
      "rollback " + undo.operationId,
      "",
    ].join("\n"),
  );
}
