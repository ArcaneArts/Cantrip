import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

const backupApi = "api/cantrip-os-backups";
const privateLabel = "private-os-backup-label-雪";
const privateFile = "private-os-backup-雪.bin";
const checkoutFile = "checkout.txt";
const laterFile = "later.txt";
const privateBytes = Buffer.concat([
  Buffer.from("private-os-backup-original\0雪"),
  Buffer.from([0xff]),
]);
const checkoutBytes = Buffer.from("private-os-backup-checkout-𐐷\n");
const destinationBytes = Buffer.from("private-os-backup-destination\0");
const laterBytes = Buffer.from("private-os-backup-after-restore\0");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function actualCantripOsBackupClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
  selected,
  fixture,
  workerId,
  projectId,
  dataDirectory,
  crashWorker,
  startWorker,
  report,
}) {
  const backup = (method, ...args) => call(backupApi, method, ...args);
  const binding = await os("createCantripOsBinding", projectId, {
    mode: "linux-owned",
    workspaceId: selected.id,
    sourceKind: "folder",
  });
  const provision = await os("prepareCantripOsProvisionRequest", binding, {
    mode: "linux-owned",
    source: { kind: "folder" },
  });
  const source = await os("submitCantripOsProvision", binding, provision);
  assert.equal(source.state, "ready", JSON.stringify(source));
  const current = await os("verifyCantripOsBinding", projectId, binding.id);
  assert.equal(current.state, "ready", JSON.stringify(current));

  const workspace = await os("createCantripOsWorkspace", instance.id, {
    operationId: randomUUID(),
    guestWorkspaceId: "backup-destination",
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: instance.runtimeGeneration,
  });
  assert.equal(workspace.state, "ready", JSON.stringify(workspace));
  const target = (await os("getCantripOsWorkspaces", instance.id)).find(
    (value) => value.guestWorkspaceId === "backup-destination",
  );
  assert.ok(target);
  assert.notEqual(target.uid, selected.uid);

  const write = (account, destination, bytes) =>
    guest.docker(
      "exec",
      "--user",
      `${account.uid}:${account.gid}`,
      guest.id,
      "sh",
      "-c",
      'umask 077; printf "%s" "$1" | base64 -d > "$2"',
      "sh",
      bytes.toString("base64"),
      destination,
    );
  const read = async (destination, bytes, account) => {
    const proof = await guest.fileProof(guest.id, destination);
    assert.deepEqual(Buffer.from(proof.base64, "base64"), bytes);
    assert.equal(proof.mode & 0o777, 0o600);
    assert.equal(proof.uid, account.uid);
    assert.equal(proof.gid, account.gid);
    return proof.sha256;
  };
  const inode = async (home) => {
    const value = await guest.exec("stat", "-c", "%d:%i", home);
    assert.match(value, /^\d+:\d+$/);
    return value;
  };
  const sourceFile = path.posix.join(selected.homeGuestPath, privateFile);
  const targetFile = path.posix.join(target.homeGuestPath, privateFile);
  const relativeCheckout = path.posix.relative(
    selected.homeGuestPath,
    current.guestPath,
  );
  assert.ok(relativeCheckout.startsWith("checkouts/"));
  await write(selected, sourceFile, privateBytes);
  await write(
    selected,
    path.posix.join(current.guestPath, checkoutFile),
    checkoutBytes,
  );
  await write(target, targetFile, destinationBytes);
  const sourceInode = await inode(selected.homeGuestPath);
  const originalInode = await inode(target.homeGuestPath);
  report.fileProofs = {};

  const prepare = async (intent) => {
    const refreshed = (await os("refreshCantripOs", instance.id)).instance;
    assert.equal(refreshed.attachmentGeneration, instance.attachmentGeneration);
    return backup("prepareCantripOsBackup", refreshed, intent);
  };
  const submit = (admission) =>
    backup("submitCantripOsBackup", instance.id, admission);
  const get = (operationId) =>
    backup("getCantripOsBackupOperation", operationId);
  const recover = (summary) =>
    backup("recoverCantripOsBackup", summary, { mode: "observe" });
  const details = async (summary, action) => {
    assert.equal(
      summary.result?.state,
      "ready",
      JSON.stringify(summary.result),
    );
    const opened = await backup("openCantripOsBackupDetails", summary);
    assert.equal(opened.intent.action, action);
    assert.equal(opened.result?.action, action, JSON.stringify(opened.result));
    for (const marker of [
      privateLabel,
      privateFile,
      checkoutBytes.toString().trim(),
    ]) {
      assert.equal(JSON.stringify(summary).includes(marker), false);
    }
    return opened.result;
  };
  report.rejections = [];
  const conflict = async (route, run, message) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === route,
      ),
      assert.rejects(run, (error) => error.message.includes(message)),
    ]);
    assert.equal(response.status(), 409);
    assert.deepEqual(await response.json(), { error: message });
    report.rejections.push({ status: response.status(), message });
  };
  const admissionPath = `/api/cantrip-os/${instance.id}/backup-operations`;
  const rejectAdmission = (input, message) =>
    conflict(admissionPath, () => submit(input), message);
  const capture = await prepare({
    action: "capture",
    workspaceId: selected.id,
    label: privateLabel,
    exclusions: [],
  });
  const captured = await submit(capture);
  const captureResult = await details(captured, "capture");
  assert.equal(captureResult.metadata.manifest.cantrip.label, privateLabel);
  assert.equal(captureResult.metadata.manifest.cantrip.sources.length, 1);
  assert.equal(
    captureResult.metadata.manifest.cantrip.sources[0].bindingId,
    binding.id,
  );
  assert.equal(
    captureResult.metadata.manifest.cantrip.sources[0].worktreeId,
    binding.worktreeId,
  );
  assert.match(captureResult.metadata.archiveSha256, /^[a-f0-9]{64}$/);
  record("source-backup-captured", captured);
  const staleTarget =
    "The selected OS workspace or runtime changed before backup admission.";
  await rejectAdmission(
    { ...capture, operationId: randomUUID(), runtimeGeneration: randomUUID() },
    staleTarget,
  );
  await rejectAdmission(
    { ...capture, operationId: randomUUID(), workspaceId: randomUUID() },
    staleTarget,
  );
  await rejectAdmission(
    { ...capture, runtimeGeneration: randomUUID() },
    "The operation ID belongs to a different backup admission.",
  );
  await rejectAdmission(
    await prepare({
      action: "restore",
      workspaceId: target.id,
      backupId: randomUUID(),
      replace: true,
    }),
    "The referenced backup operation belongs to another target or storage Worker.",
  );
  const directory = path.join(dataDirectory, "cantrip-os-backups");
  const [bucket] = await readdir(directory);
  const archiveFile = path.join(
    directory,
    bucket,
    capture.operationId,
    "archive.ctos",
  );
  const archive = await readFile(archiveFile);
  for (const marker of [
    Buffer.from(privateLabel),
    privateBytes,
    checkoutBytes,
  ]) {
    assert.equal(archive.includes(marker), false);
  }
  report.archive = {
    bytes: archive.length,
    sha256: digest(archive),
    ciphertext: archive.toString("base64"),
  };

  const responseDirectory = path.join(dataDirectory, "test-backup-responses");
  const held = async (admission) => {
    const target = path.join(responseDirectory, admission.operationId);
    await writeFile(target + ".armed", "", { flag: "wx" });
    let early;
    const pending = submit(admission).then(
      (value) => (early = { ok: true, value }),
      (error) => (early = { ok: false, message: error.message }),
    );
    const seen = await eventually(
      async () => {
        if (early)
          throw new Error(
            "Backup returned before reply drop: " + JSON.stringify(early),
          );
        try {
          return JSON.parse(await readFile(target + ".json", "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return null;
        }
      },
      (value) => assert.ok(value),
      60000,
    );
    assert.equal(seen.envelope.result.operationId, admission.operationId);
    assert.equal(seen.envelope.result.action, admission.action);
    assert.equal(seen.envelope.result.state, "ready");
    return { pending, seen };
  };
  const online = () =>
    eventually(
      () => call("api/worker-wire", "getWorkers"),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );

  const restore = await prepare({
    action: "restore",
    workspaceId: target.id,
    backupId: capture.operationId,
    replace: true,
  });
  const restoreDrop = await held(restore);
  report.fileProofs.restored = await read(targetFile, privateBytes, target);
  report.fileProofs.checkout = await read(
    path.posix.join(target.homeGuestPath, relativeCheckout, checkoutFile),
    checkoutBytes,
    target,
  );
  const restoredInode = await inode(target.homeGuestPath);
  assert.notEqual(restoredInode, originalInode);
  report.restoreServerCrash = fixture.workerFixture
    ? await fixture.replacePeer(0, fixture.peers[0].kind, { crash: true })
    : await fixture.restart({ crash: true });
  assert.equal((await restoreDrop.pending).ok, false);
  const admittedRestore = await get(restore.operationId);
  assert.equal(admittedRestore.result, null);
  assert.deepEqual(admittedRestore.protectedRequest, restore.protectedRequest);
  await online();
  const restored = await recover(admittedRestore);
  assert.deepEqual(restored.result, restoreDrop.seen.envelope.result);
  const restoredPrivate = await details(restored, "restore");
  assert.equal(restoredPrivate.receipt.runtime_handles_restored, false);
  assert.equal(
    restoredPrivate.receipt.archive_sha256,
    captureResult.metadata.archiveSha256,
  );
  assert.equal(restoredPrivate.receipt.workspace.uid, target.uid);
  assert.equal(
    await inode(restoredPrivate.receipt.retained_original_home),
    originalInode,
  );
  record("source-backup-restore-recovered", restored);
  assert.deepEqual(await submit(restore), restored);
  assert.equal(await inode(target.homeGuestPath), restoredInode);

  await write(
    target,
    path.posix.join(target.homeGuestPath, laterFile),
    laterBytes,
  );
  await rejectAdmission(
    await prepare({
      action: "rollback",
      workspaceId: selected.id,
      restoreOperationId: restore.operationId,
    }),
    "Rollback must target the original restore workspace.",
  );
  await rejectAdmission(
    await prepare({
      action: "restore",
      workspaceId: target.id,
      backupId: restore.operationId,
      replace: true,
    }),
    "The referenced backup operation belongs to another target or storage Worker.",
  );
  await conflict(
    `/api/cantrip-os/backup-operations/${restore.operationId}/recovery`,
    () =>
      backup("recoverCantripOsBackup", restored, {
        mode: "continue",
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: randomUUID(),
      }),
    "The continuation target changed. Check recovery and select its current runtime before continuing.",
  );
  const rollback = await prepare({
    action: "rollback",
    workspaceId: target.id,
    restoreOperationId: restore.operationId,
  });
  const rollbackDrop = await held(rollback);
  report.fileProofs.rolledBack = await read(
    targetFile,
    destinationBytes,
    target,
  );
  assert.equal(await inode(target.homeGuestPath), originalInode);
  await crashWorker();
  const interrupted = await rollbackDrop.pending;
  assert.equal(interrupted.ok, true, JSON.stringify(interrupted));
  assert.equal(interrupted.value.result?.state, "unknown");
  assert.equal(interrupted.value.result.protectedResult, null);
  await startWorker();
  await online();
  const rolled = await recover(interrupted.value);
  assert.deepEqual(rolled.result, rollbackDrop.seen.envelope.result);
  const rolledPrivate = await details(rolled, "rollback");
  assert.equal(rolledPrivate.receipt.runtime_handles_restored, false);
  assert.equal(rolledPrivate.receipt.restore_operation_id, restore.operationId);
  const retained = rolledPrivate.receipt.retained_replaced_home;
  assert.equal(await inode(retained), restoredInode);
  report.fileProofs.displaced = await read(
    path.posix.join(retained, laterFile),
    laterBytes,
    target,
  );
  record("source-backup-rollback-recovered", rolled);
  assert.deepEqual(await submit(rollback), rolled);
  assert.equal(await inode(target.homeGuestPath), originalInode);

  const reopened = await backup("getCantripOsBackupOperations");
  assert.equal(reopened.nextCursor, null);
  assert.equal(reopened.items.length, 3);
  for (const summary of [captured, restored, rolled]) {
    assert.deepEqual(
      reopened.items.find((item) => item.operationId === summary.operationId),
      summary,
    );
    await details(summary, summary.action);
  }
  assert.equal(digest(await readFile(archiveFile)), report.archive.sha256);
  report.fileProofs.source = await read(sourceFile, privateBytes, selected);
  assert.equal(await inode(selected.homeGuestPath), sourceInode);
  report.homeIdentities = {
    source: sourceInode,
    original: originalInode,
    restored: restoredInode,
  };
  report.replies = { restore: restoreDrop.seen, rollback: rollbackDrop.seen };
  report.retainedOperations = reopened.items;
  record("source-backup-history", reopened);
}
