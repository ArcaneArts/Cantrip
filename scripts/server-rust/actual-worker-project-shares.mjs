// Existing share API and full worker, including real WebDAV filesystem effects.
// The standalone chat is an existing-installation fixture, not chat creation QA.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ChatScratchManager } from "../../cantrip_worker/src/chat-scratch.ts";
import { repositoryFixture } from "./repository-fixture.mjs";
import { standaloneSql } from "./project-share-http-state.mjs";
import { eventually } from "./full-worker.mjs";
import {
  openShareCarrier,
  closeShareCarrier,
  webdav,
} from "./project-share-webdav.mjs";

const catalog = (page) =>
  page.evaluate(async () => {
    const rows = await window.folderRequest("/api/tunnels");
    return rows.filter((row) => row.origin === "project-share");
  });
const create = (page, project) =>
  page.evaluate(async (project) => {
    const api = await import("/src/lib/api/network-shares.ts");
    return api.createProjectNetworkShare(project);
  }, project);
const revoke = (page, id) =>
  page.evaluate(async (id) => {
    const api = await import("/src/lib/api/network-shares.ts");
    await api.deleteProjectNetworkShare(id);
  }, id);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function opaqueShare(page, share, root, requests) {
  const row = (await catalog(page)).find(
    (row) => row.id === share.attachmentId,
  );
  assert.ok(row);
  assert.equal(row.destination.kind, "worker-adapter");
  assert.equal(row.destination.adapter, "project-share");
  assert.equal(row.destination.resourceId, share.attachmentId);
  const observed = JSON.stringify({ row, requests });
  for (const secret of [
    root,
    share.username,
    share.password,
    new URL(share.url).pathname,
  ]) {
    assert.equal(
      observed.includes(secret),
      false,
      "share credentials and filesystem root remain endpoint-only",
    );
  }
}

async function readWrite({
  page,
  share,
  workerId,
  root,
  payload,
  result,
  kind = "link",
  expectedPut = 201,
}) {
  const carrier = await openShareCarrier(
    page,
    share.attachmentId,
    workerId,
    kind,
  );
  try {
    const denied = await webdav(
      page,
      carrier,
      { ...share, password: "wrong:" + share.password },
      "GET",
      "share-proof.txt",
    );
    assert.equal(
      denied.status,
      401,
      "incorrect Digest credentials cannot read files",
    );
    const put = await webdav(
      page,
      carrier,
      share,
      "PUT",
      "share-proof.txt",
      payload,
    );
    assert.equal(put.status, expectedPut, "authenticated WebDAV PUT");
    assert.deepEqual(
      await readFile(path.join(root, "share-proof.txt")),
      payload,
    );
    const get = await webdav(page, carrier, share, "GET", "share-proof.txt");
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, payload);
    const listing = await webdav(
      page,
      carrier,
      share,
      "PROPFIND",
      "",
      Buffer.alloc(0),
      { Depth: "1" },
    );
    assert.equal(listing.status, 207);
    assert.ok(listing.body.includes(Buffer.from("share-proof.txt")));
    (result.projectShareTransfers ??= []).push({
      kind,
      bytes: payload.length,
      sha256: digest(payload),
      authenticatedWrite: true,
      listing: true,
    });
    return carrier;
  } catch (error) {
    await closeShareCarrier(page, carrier).catch(() => {});
    throw error;
  }
}

export async function prepareProjectShares({
  page,
  project,
  workerId,
  result,
  requests,
}) {
  const share = await create(page, project);
  assert.equal(share.projectId, project.id);
  await opaqueShare(page, share, project.source.path, requests);
  const payload = Buffer.from("Private WebDAV proof 🍄:" + "x".repeat(40000));
  const carrier = await readWrite({
    page,
    share,
    workerId,
    root: project.source.path,
    payload,
    result,
  });
  const first = (await catalog(page)).find(
    (row) => row.id === share.attachmentId,
  );
  assert.equal(first.protectedRecord.revision, 1);
  const refreshed = await create(page, project);
  assert.equal(refreshed.attachmentId, share.attachmentId);
  assert.notEqual(refreshed.password, share.password);
  assert.notEqual(refreshed.username, share.username);
  await opaqueShare(page, refreshed, project.source.path, requests);
  await eventually(
    () => page.evaluate((key) => window.shareCarriers[key].closed, carrier.key),
    (code) => assert.ok(code, "refresh revokes the installed share grant"),
  );
  const changed = (await catalog(page)).find(
    (row) => row.id === share.attachmentId,
  );
  assert.equal(changed.protectedRecord.revision, 2);
  assert.notEqual(
    changed.protectedRecord.operationId,
    first.protectedRecord.operationId,
  );
  const legacy = await readWrite({
    page,
    share: refreshed,
    workerId,
    root: project.source.path,
    payload,
    result,
    kind: "legacy",
    expectedPut: 200,
  });
  await closeShareCarrier(page, legacy);
  result.steps.push(
    "existing project-share API opens protected WebDAV; real WorkerLink and legacy tunnels enforce Digest credentials, write/read 40 KB and list files; refresh revokes the old grant",
  );
  return {
    project,
    workerId,
    share: refreshed,
    payload,
    record: changed.protectedRecord,
  };
}

export async function prepareExistingScratch(dataDirectory) {
  const chatId = randomUUID(),
    rootId = randomUUID();
  const provisioned = await new ChatScratchManager(dataDirectory).provision({
    jobId: randomUUID(),
    attempt: 1,
    chatId,
    rootId,
  });
  return { chatId, rootId, path: provisioned.path };
}

export async function seedExistingScratch({
  fixture,
  root,
  executable,
  page,
  scratch,
  workerId,
}) {
  const owner = await page.evaluate(() => window.folderIdentity.ownerId);
  const repo = await repositoryFixture({
    kind: fixture.kind,
    root: path.join(root, fixture.name),
    executable,
    databaseMode: fixture.databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    const result = await repo.request({
      op: "transaction",
      statements: standaloneSql(owner, { ...scratch, workerId }),
    });
    assert.equal(result.rejected, false, result.diagnostic);
  } finally {
    await repo.close();
  }
}

export async function finishProjectShares({
  page,
  prepared,
  scratch,
  result,
  requests,
}) {
  const { project, workerId, share, payload } = prepared;
  const retained = (await catalog(page)).find(
    (row) => row.id === share.attachmentId,
  );
  assert.equal(
    retained,
    undefined,
    "startup removes transient project-share state",
  );
  const reopened = await create(page, project);
  assert.notEqual(reopened.attachmentId, share.attachmentId);
  await opaqueShare(page, reopened, project.source.path, requests);
  const carrier = await openShareCarrier(page, reopened.attachmentId, workerId);
  try {
    const get = await webdav(page, carrier, reopened, "GET", "share-proof.txt");
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, payload);
    const removed = await webdav(
      page,
      carrier,
      reopened,
      "DELETE",
      "share-proof.txt",
    );
    assert.equal(removed.status, 200);
    await revoke(page, reopened.attachmentId);
    await eventually(
      () =>
        page.evaluate((key) => window.shareCarriers[key].closed, carrier.key),
      (code) => assert.ok(code, "share deletion revokes active grants"),
    );
    assert.equal(
      (await catalog(page)).some((row) => row.id === reopened.attachmentId),
      false,
    );
  } finally {
    await closeShareCarrier(page, carrier).catch(() => {});
  }
  const chat = {
    id: scratch.chatId,
    activeWorkerId: workerId,
    activeScratchRootId: scratch.rootId,
  };
  const chatShare = await page.evaluate(async (chat) => {
    const api = await import("/src/lib/api/network-shares.ts");
    return api.createStandaloneChatNetworkShare(chat);
  }, chat);
  assert.equal(chatShare.chatId, chat.id);
  await opaqueShare(page, chatShare, scratch.path, requests);
  const chatCarrier = await readWrite({
    page,
    share: chatShare,
    workerId,
    root: scratch.path,
    payload,
    result,
  });
  try {
    const row = (await catalog(page)).find(
      (row) => row.id === chatShare.attachmentId,
    );
    assert.equal(row.projectId, null);
    assert.deepEqual(row.managedBy, {
      kind: "project-share",
      id: "chat:" + chat.id,
    });
    await revoke(page, chatShare.attachmentId);
    await eventually(
      () =>
        page.evaluate(
          (key) => window.shareCarriers[key].closed,
          chatCarrier.key,
        ),
      (code) => assert.ok(code),
    );
    assert.deepEqual(await catalog(page), []);
  } finally {
    await closeShareCarrier(page, chatCarrier).catch(() => {});
  }
  result.steps.push(
    "server/worker restart clears ephemeral share state and retains file bytes; client reopens a new share; deletion revokes grants; existing standalone scratch root serves authenticated WebDAV through the unchanged worker",
  );
  result.projectShares = {
    completed: true,
    projectId: project.id,
    fileBytesRetained: true,
    ephemeralShareReset: true,
    standaloneScratch: true,
    grantRevocation: true,
    endpointOpacity: true,
  };
}

export async function liveWorkerShareRestart({
  page,
  fixture,
  project,
  workerId,
  worker,
  result,
  requests,
}) {
  const share = await create(page, project);
  await opaqueShare(page, share, project.source.path, requests);
  const payload = Buffer.from(
    "Standalone live-worker restart:" + "y".repeat(40000),
  );
  const carrier = await readWrite({
    page,
    share,
    workerId,
    root: project.source.path,
    payload,
    result,
  });
  const port = Number(new URL(fixture.server.origin).port),
    pid = worker.child.pid;
  let reopenedCarrier;
  try {
    await fixture.close({ shutdownTimeoutMs: 105000 });
    assert.equal(
      worker.child.exitCode,
      null,
      "standalone server restart retains the actual worker process",
    );
    assert.equal(worker.child.signalCode, null);
    await fixture.start({ port });
    assert.equal(worker.child.pid, pid);
    assert.equal(
      (await catalog(page)).some((row) => row.id === share.attachmentId),
      false,
    );
    await eventually(
      () =>
        page.evaluate((key) => window.shareCarriers[key].closed, carrier.key),
      (closed) =>
        assert.ok(closed, "server restart retires the old share channel"),
    );
    const attempts = [];
    const opened = await eventually(
      () =>
        page.evaluate(async (project) => {
          const api = await import("/src/lib/api/network-shares.ts");
          const { CantripApiError } = await import("/src/lib/api-client.ts");
          const { EndpointContentWorkerEncryptionError } =
            await import("/src/lib/endpoint-content-worker-encryption.ts");
          try {
            return { share: await api.createProjectNetworkShare(project) };
          } catch (error) {
            if (
              error instanceof CantripApiError &&
              error.status === 503 &&
              error.code === "worker-offline"
            )
              return { offline: true };
            if (
              error instanceof EndpointContentWorkerEncryptionError &&
              error.state === "offline"
            )
              return { offline: true };
            throw error;
          }
        }, project),
      (value) => {
        attempts.push(value.offline ? "worker-offline" : "opened");
        assert.ok(value.share, "actual share open after worker reconnect");
      },
    );
    const reopened = opened.share;
    assert.notEqual(reopened.attachmentId, share.attachmentId);
    await opaqueShare(page, reopened, project.source.path, requests);
    reopenedCarrier = await openShareCarrier(
      page,
      reopened.attachmentId,
      workerId,
    );
    const received = await webdav(
      page,
      reopenedCarrier,
      reopened,
      "GET",
      "share-proof.txt",
    );
    assert.equal(received.status, 200);
    assert.deepEqual(received.body, payload);
    await revoke(page, reopened.attachmentId);
    await eventually(
      () =>
        page.evaluate(
          (key) => window.shareCarriers[key].closed,
          reopenedCarrier.key,
        ),
      (closed) => assert.ok(closed),
    );
    assert.equal(worker.child.pid, pid);
    result.liveWorkerShareRestart = {
      passed: true,
      sameWorkerProcess: true,
      bytes: payload.length,
      sha256: digest(payload),
      oldChannelRetired: true,
      freshShareIdentity: true,
      retainedFileBytes: true,
      attempts,
    };
    result.steps.push(
      "standalone server restarts while the unchanged worker process stays alive; old share authority retires and a fresh client share reads the retained file bytes",
    );
  } finally {
    await closeShareCarrier(page, carrier).catch(() => {});
    if (reopenedCarrier)
      await closeShareCarrier(page, reopenedCarrier).catch(() => {});
  }
}
