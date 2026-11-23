import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "../../packages/crypto/dist/index.js";
import {
  openPrivateBackup,
  sealPrivateBackup,
} from "../../tests/reference-node-worker/src/os-executor/private-backup-file.ts";
import { grantCantripOsFixture } from "./cantrip-os-grant.mjs";

export async function verifyCantripOsCapture({
  call,
  workerId,
  data,
  repositoryKey,
  serverId,
  root,
  os,
  actual,
  workspaceUrl,
  docker,
  container,
  backupTrace,
  backupPublished,
  backupRelease,
  storageKey,
  eventually,
  crashWorker,
  startWorker,
  restore,
}) {
  const componentKey =
    repositoryKey ??
    (await grantCantripOsFixture(call, workerId, data, false, false)).get(
      "repository-content",
    );
  const keys = {
    ownerId: () => os.ownerId,
    serverIdentity: () => serverId,
    componentKey: () => ({ keyRevision: 1, key: componentKey.slice() }),
  };
  const workspace = (await call("GET", workspaceUrl)).find(
    (value) => value.guestWorkspaceId === actual.id,
  );
  assert.ok(workspace);
  const operationId = randomUUID();
  const context = { ownerId: os.ownerId, serverId, backupId: operationId };
  const protection = {
    ownerId: os.ownerId,
    serverId,
    operationId,
    componentKey,
    keyRevision: 1,
  };
  const label = "private capture evidence 雪";
  const file = path.join(root, "payload");
  const marker = Buffer.concat([
    Buffer.from(label),
    randomBytes(1024 * 1024 + 37),
  ]);
  await writeFile(file, marker);
  await docker("cp", file, container + ":" + actual.home + "/private-雪");
  await docker(
    "exec",
    "--user",
    "0",
    container,
    "chown",
    actual.uid + ":" + actual.gid,
    actual.home + "/private-雪",
  );
  const request = {
    action: "capture",
    operationId,
    workspaceId: workspace.id,
    attachmentGeneration: os.attachmentGeneration,
    runtimeGeneration: os.runtimeGeneration,
    protectedRequest: await encryptCantripOsBackupMessage({
      ...protection,
      direction: "request",
      plaintext: Buffer.from(
        JSON.stringify({
          action: "capture",
          workspaceId: workspace.id,
          label,
          exclusions: [],
        }),
      ),
    }),
  };
  const route = "/api/cantrip-os/" + os.id + "/backup-operations";
  const recovery =
    "/api/cantrip-os/backup-operations/" + operationId + "/recovery";
  const submit = call("POST", route, request);
  try {
    await Promise.race([
      eventually(
        async () =>
          assert.equal(
            (await readFile(backupPublished, "utf8")).trim(),
            operationId,
          ),
        120_000,
      ),
      submit.then((reply) => {
        throw new Error(
          "Capture completed before publication interruption in state " +
            reply.result.state,
        );
      }),
    ]);
    await crashWorker();
    await writeFile(backupRelease, "");
    const interrupted = await submit;
    assert.equal(
      interrupted.result.state,
      "unknown",
      JSON.stringify(interrupted),
    );

    const source = path.join(
      data,
      "cantrip-os-backups",
      storageKey,
      operationId,
      "archive.ctos",
    );
    const original = await readFile(source);
    assert.ok(!original.includes(Buffer.from(label)));
    const clear = path.join(root, "opened.tar");
    const opened = await openPrivateBackup({
      context,
      keys,
      source,
      destination: clear,
    });
    assert.ok((await readFile(clear)).includes(marker));
    assert.equal(opened.metadata.manifest.cantrip.label, label);
    assert.equal(opened.metadata.manifest.workspace.id, actual.id);
    assert.ok(opened.metadata.archiveBytes > 1024 * 1024);

    // A valid header and chunks cannot stand in for an authenticated EOF.
    await writeFile(
      source,
      original.subarray(0, original.lastIndexOf(10, original.length - 2) + 1),
    );
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
    assert.equal(
      (await call("POST", recovery, { mode: "observe" })).result.state,
      "unknown",
    );

    // Create the replacement with the production Node writer to prove that
    // the Rust worker can reopen existing version-one archives after upgrade.
    const legacy = path.join(root, "legacy.ctos");
    await sealPrivateBackup({
      context,
      keys,
      destination: legacy,
      metadata: opened.metadata,
      archive: createReadStream(clear),
    });
    await rename(legacy, source);
    const recovered = await call("POST", recovery, { mode: "observe" });
    assert.equal(recovered.result.state, "ready", JSON.stringify(recovered));
    const proof = JSON.parse(
      Buffer.from(
        await decryptCantripOsBackupMessage({
          ...protection,
          direction: "response",
          frame: recovered.result.protectedResult,
        }),
      ).toString("utf8"),
    );
    assert.equal(proof.action, "capture");
    assert.deepEqual(proof.metadata, opened.metadata);
    assert.ok(!JSON.stringify(recovered).includes(label));
    assert.deepEqual(
      (await call("POST", route, request)).result.protectedResult,
      recovered.result.protectedResult,
    );
    assert.equal(await readFile(backupTrace, "utf8"), operationId + "\n");
    if (restore) {
      const { verifyCantripOsRecovery } =
        await import("./cantrip-os-restore-cases.mjs");
      await verifyCantripOsRecovery({
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
        metadata: opened.metadata,
        ...restore,
      });
    }
  } finally {
    if (!repositoryKey) componentKey.fill(0);
  }
}
