import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ids, chatId } from "./project-share-http-state.mjs";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
import { shareWorker } from "./project-share-http-worker.mjs";
import { eventually } from "./full-worker.mjs";

export const input = (index = 0, revision = 1, operation = index) => ({
  tunnelId: ids[index],
  workerId: "alpha",
  protectedRecord: { ...tunnelRecord, revision, operationId: ids[operation] },
});
async function callerAbort({
  fixture,
  worker,
  result,
  visit,
  liveEvents,
  livePing,
}) {
  worker.mode = "hold";
  const before = result.commands.length,
    beforeEvents = liveEvents().length;
  const client = fixture.client();
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:5173",
    cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
    ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
  };
  const abort = new AbortController();
  const request = fetch(
    fixture.server.origin + "/api/projects/github/network-shares",
    {
      method: "POST",
      headers,
      body: JSON.stringify(input(8)),
      signal: abort.signal,
    },
  ).then(
    () => null,
    (error) => error,
  );
  try {
    await eventually(
      () => result.commands.slice(before),
      (cs) =>
        assert.ok(cs.some((c) => c.command.type === "project.share.open")),
    );
    abort.abort();
    assert.equal((await request)?.name, "AbortError");
  } finally {
    worker.release();
    worker.mode = "ok";
  }
  await eventually(
    () => liveEvents().length,
    (n) => assert.equal(n, beforeEvents + 1),
  );
  await livePing("caller-disconnected share commit");
  result.changes.push({
    name: "caller-disconnected share commit",
    events: liveEvents().slice(beforeEvents),
  });
  const stored = await visit(
    "admitted share survived caller disconnect",
    "GET",
    "/api/tunnels/" + ids[8],
  );
  assert.equal(stored.protectedRecord.revision, 1);
  await visit(
    "delete caller-disconnected share",
    "DELETE",
    "/api/project-shares/" + ids[8],
    { status: 204, events: 1 },
  );
  result.callerAbort = {
    actualClientAbort: true,
    workerRequestObserved: true,
    committedProtectedRevision: 1,
  };
}
export async function shareHttpCases({
  fixture,
  root,
  profile,
  result,
  visit,
  liveEvents,
  livePing,
}) {
  let worker, foreign;
  const project = "/api/projects/github/network-shares",
    chat = `/api/chats/${chatId}/network-shares`;
  const create = (name, body = input(), options = {}) =>
    visit(name, "POST", project, {
      json: body,
      status: 201,
      events: 1,
      ...options,
    });
  const remove = (name, index = 0, options = {}) =>
    visit(name, "DELETE", "/api/project-shares/" + ids[index], {
      status: 204,
      events: 1,
      ...options,
    });
  try {
    for (const [i, body] of [
      null,
      {},
      [],
      { ...input(), extra: true },
      { ...input(), worktreeId: null },
      input(0, 1, 1),
    ].entries())
      await visit("invalid body " + i, "POST", project, {
        json: body,
        status: 400,
      });
    for (const target of ["missing", "other"])
      await visit(
        "foreign or missing project " + target,
        "POST",
        `/api/projects/${target}/network-shares`,
        { json: input(), status: 404 },
      );
    await visit("missing worktree", "POST", project, {
      json: { ...input(), worktreeId: "missing" },
      status: 404,
    });
    await visit("worktree targets other worker", "POST", project, {
      json: { ...input(), worktreeId: "github-beta-main" },
      status: 409,
    });
    await visit(
      "scratch forbids worktree before lookup",
      "POST",
      "/api/chats/missing/network-shares",
      { json: { ...input(), worktreeId: "tree" }, status: 400 },
    );
    for (const target of ["missing", "other-chat"])
      await visit(
        "missing chat " + target,
        "POST",
        `/api/chats/${target}/network-shares`,
        { json: input(), status: 404 },
      );
    await visit(
      "project chat cannot share scratch",
      "POST",
      "/api/chats/chat/network-shares",
      { json: input(), status: 409 },
    );
    await visit("scratch targets other worker", "POST", chat, {
      json: { ...input(), workerId: "beta" },
      status: 409,
    });
    await visit("worker offline typed failure", "POST", project, {
      json: input(),
      status: 503,
    });
    worker = await shareWorker({ fixture, root, visit, result });
    if (profile === "accounts") {
      await visit("requires CSRF", "POST", project, {
        json: input(),
        csrf: false,
        status: 403,
      });
      foreign = await shareWorker({
        fixture,
        root,
        visit,
        result,
        id: "foreign",
        client: "other",
      });
      await visit(
        "foreign share creation",
        "POST",
        "/api/projects/other/network-shares",
        {
          client: "other",
          json: { ...input(9), workerId: "foreign" },
          status: 201,
        },
      );
      await visit(
        "owned share hidden from other owner",
        "DELETE",
        "/api/project-shares/" + ids[9],
        { status: 404 },
      );
    }
    await visit("scratch capability required", "POST", chat, {
      json: input(5),
      status: 409,
    });
    await worker.heartbeat(true);
    await create("project share created");
    let stored = await visit(
      "created catalog",
      "GET",
      "/api/tunnels/" + ids[0],
    );
    assert.equal(stored.protectedRecord.revision, 1);
    assert.equal(stored.destination.adapter, "project-share");
    assert.equal(stored.destination.resourceId, ids[0]);
    await visit(
      "create attachment",
      "POST",
      `/api/tunnels/${ids[0]}/attachments`,
      { json: { clientId: "share-client" }, status: 201, events: 2 },
    );
    const attachment = fixture.records.get("create attachment").attachmentId;
    await create("refresh preserves and stops attachments", input(0, 2, 1), {
      events: 2,
    });
    stored = await visit("refreshed catalog", "GET", "/api/tunnels/" + ids[0]);
    assert.equal(stored.protectedRecord.revision, 2);
    assert.equal(
      stored.attachments.find((a) => a.id === attachment)?.status,
      "stopped",
    );
    await create("stale tunnel identity", input(2), { status: 409, events: 0 });
    await create("stale protected revision", input(), {
      status: 409,
      events: 1,
    });
    await create("reused operation identity", input(0, 3, 1), {
      status: 409,
      events: 1,
    });
    worker.closeMode = "error";
    await create("close failure remains best effort", input(0, 3, 2), {
      events: 2,
    });
    worker.closeMode = "hold";
    const beforeClose = Date.now();
    await create("actual five second close deadline", input(0, 4, 3), {
      events: 2,
    });
    result.closeDeadlineMs = Date.now() - beforeClose;
    assert.ok(result.closeDeadlineMs >= 4900);
    worker.release();
    worker.closeMode = "ok";
    await remove("delete project share", 0, { events: 2 });
    await remove("repeat deletion", 0, { status: 404, events: 0 });
    for (const mode of [
      "invalid",
      "extra",
      "mismatch",
      "error",
      "coded-error",
      "other-code",
    ]) {
      worker.mode = mode;
      const response = await create("worker reply " + mode, input(), {
        status: mode === "coded-error" ? 409 : 502,
        events: 0,
      });
      assert.equal(
        response.failureStage,
        ["invalid", "extra", "mismatch"].includes(mode)
          ? "worker-response-validation"
          : "worker-share-open",
      );
      assert.ok(!JSON.stringify(response).includes("PRIVATE_SHARE_FAILURE"));
    }
    worker.mode = "ok";
    await create("actual insert failure closes worker", input(10), {
      status: 502,
      events: 0,
    });
    await visit("failed insert rolled back", "GET", "/api/tunnels/" + ids[10], {
      status: 404,
    });
    await create("create before actual update failure");
    await create("actual update rollback closes worker", input(0, 2, 11), {
      status: 502,
      events: 0,
    });
    stored = await visit(
      "actual failed update retained old revision",
      "GET",
      "/api/tunnels/" + ids[0],
    );
    assert.equal(stored.protectedRecord.revision, 1);
    await remove("delete after rollback");
    worker.mode = "hold";
    const started = Date.now();
    await create("actual thirty second open deadline", input(), {
      status: 502,
      events: 0,
      timeoutMs: 45000,
    });
    result.openDeadlineMs = Date.now() - started;
    assert.ok(result.openDeadlineMs >= 29500);
    worker.release();
    worker.mode = "ok";
    await worker.heartbeat(true);
    worker.mode = "hold";
    const beforeEvents = liveEvents().length,
      beforeCommands = result.commands.length;
    const opening = create(
      "inflight open awaits worker acknowledgment",
      input(),
      { deferEvents: true },
    );
    await eventually(
      () => result.commands.slice(beforeCommands),
      (cs) =>
        assert.ok(cs.some((c) => c.command.type === "project.share.open")),
    );
    let deleted = false;
    const deleting = remove("deletion waits for resource mutation", 0, {
      deferEvents: true,
    }).then((v) => {
      deleted = true;
      return v;
    });
    try {
      await delay(100);
      assert.equal(deleted, false);
      assert.equal(
        result.commands
          .slice(beforeCommands)
          .filter((c) => c.command.type === "project.share.close").length,
        0,
      );
    } finally {
      worker.release();
    }
    await Promise.all([opening, deleting]);
    worker.mode = "ok";
    await livePing("ordered concurrent resource mutations");
    const changes = liveEvents().slice(beforeEvents);
    assert.equal(changes.length, 2);
    result.changes.push({
      name: "ordered concurrent resource mutations",
      events: changes,
    });
    await callerAbort({ fixture, worker, result, visit, liveEvents, livePing });
    await visit("scratch share created", "POST", chat, {
      json: input(5),
      status: 201,
      events: 1,
    });
    stored = await visit("scratch catalog", "GET", "/api/tunnels/" + ids[5]);
    assert.equal(stored.projectId, null);
    assert.deepEqual(stored.managedBy, {
      kind: "project-share",
      id: "chat:" + chatId,
    });
    await visit("scratch stale identity", "POST", chat, {
      json: input(6),
      status: 409,
    });
    await visit("scratch refresh", "POST", chat, {
      json: input(5, 2, 6),
      status: 201,
      events: 1,
    });
    await remove("scratch deletion", 5);
    if (foreign)
      await remove("foreign owner deletes its share", 9, {
        client: "other",
        events: 0,
      });
    assert.equal(
      fixture.server.diagnostics().includes("PRIVATE_SHARE_FAILURE"),
      false,
      "Server retains only redacted project-share diagnostics",
    );
  } finally {
    await foreign?.close();
    await worker?.close();
  }
}
