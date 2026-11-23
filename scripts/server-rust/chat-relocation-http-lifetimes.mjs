// Real SQL locks expose admitted HTTP work without replacing lifecycle methods.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function headers(fixture, body) {
  const client = fixture.client();
  return {
    origin: "http://127.0.0.1:5173",
    connection: "close",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...(client.cookies.size
      ? { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
      : {}),
    ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
  };
}
export async function relocationCallerShutdown({
  fixture,
  live,
  reset,
  target,
  stateQuery,
  normal,
  startedAt,
  result,
}) {
  await reset();
  const observer = postgres(new URL(fixture.environment.DATABASE_URL).href, {
    max: 1,
  });
  const locker = postgres(new URL(fixture.environment.DATABASE_URL).href, {
    max: 1,
  });
  const held = deferred(),
    release = deferred();
  let transaction, caller, closing, shutdownFailure, lockerPid;
  try {
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
      await sql`LOCK TABLE chat_relocation_snapshots IN ACCESS EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const body = JSON.stringify({
      target,
      approved: true,
      idempotencyKey: "disconnected-admission",
    });
    const outcome = new Promise((resolve) => {
      caller = request(
        fixture.server.origin + "/api/chats/chat/relocations",
        { method: "POST", headers: headers(fixture, body) },
        (response) => {
          response.resume();
          response.once("end", () => resolve({ status: response.statusCode }));
        },
      );
      caller.once("error", resolve);
      caller.end(body);
    });
    const blocked = await eventually(
      () =>
        observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%chat_relocation_snapshots%'`,
      (rows) =>
        assert.equal(
          rows.length,
          1,
          "Actual admitted snapshot INSERT waits for the held table lock",
        ),
      15000,
    );
    const disconnected = new Error(
      "intentional relocation admission disconnect",
    );
    caller.destroy(disconnected);
    assert.equal(await outcome, disconnected);
    await live.close();
    result.callerShutdownDiagnostics = fixture.server.diagnostics();
    const child = fixture.server.child;
    let closed = false;
    closing = fixture.close().then(
      () => {
        closed = true;
      },
      (error) => {
        closed = true;
        shutdownFailure = error;
      },
    );
    await delay(150);
    assert.equal(
      closed,
      false,
      "Shutdown retains already-admitted relocation work after caller closure",
    );
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(
      (
        await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%chat_relocation_snapshots%'`
      ).length,
      1,
      "The same real INSERT survives caller disconnect and service shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const rows = await observer.unsafe(stateQuery);
    const snapshot = JSON.parse(rows[0].result);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.snapshots.length, 1);
    const job = snapshot.jobs[0],
      captured = snapshot.snapshots[0];
    assert.equal(job.idempotency_key, "disconnected-admission");
    assert.equal(job.state, "queued");
    assert.equal(job.attempt, 0);
    assert.equal(job.command_id, null);
    assert.equal(captured.job_id, job.id);
    assert.equal(captured.message_count, 1);
    assert.equal(
      snapshot.chats.find((chat) => chat.id === "chat").active_worker_id,
      "alpha",
    );
    assert.ok(captured.payload.messages[0].protectedContent);
    assert.equal(captured.payload.messages[0].content, undefined);
    return {
      actualSnapshotInsertObserved: true,
      callerDisconnected: true,
      shutdownWaitedForCommit: true,
      cleanShutdown: true,
      snapshot: normal(fixture, snapshot, "", startedAt),
    };
  } finally {
    caller?.destroy();
    release.resolve();
    const cleanup = await Promise.allSettled([transaction, closing]);
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const rejected = cleanup.find((step) => step.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}

export async function relocationUnsafeCancellation({
  fixture,
  state,
  live,
  reset,
  visit,
  read,
  waitJob,
  target,
  stateQuery,
  normal,
  startedAt,
}) {
  await reset();
  state.mode = "commit-cancellation-fence";
  const observer = postgres(new URL(fixture.environment.DATABASE_URL).href, {
    max: 1,
  });
  const locker = postgres(new URL(fixture.environment.DATABASE_URL).href, {
    max: 1,
  });
  const held = deferred(),
    unlock = deferred(),
    hydration = deferred();
  state.hydrationBarrier = hydration.promise;
  const offset = state.commands.length;
  let transaction, lockerPid;
  try {
    const job = await visit(
      "unsafe cancel admission",
      "POST",
      "/api/chats/chat/relocations",
      {
        status: 202,
        json: {
          target,
          approved: true,
          idempotencyKey: "commit-cancellation-fence",
        },
      },
    );
    await eventually(
      () => state.commands.slice(offset),
      (commands) =>
        assert.equal(
          commands.filter(
            (call) =>
              call.command.type === "chat.relocation.hydration.complete",
          ).length,
          1,
        ),
    );
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
      await sql`SELECT id FROM chats WHERE id='chat' FOR UPDATE`;
      held.resolve();
      await unlock.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    state.hydrationBarrier = null;
    hydration.resolve();
    const committing = await eventually(
      () => read(`/api/chat-relocations/${job.id}`),
      (job) => assert.equal(job.state, "ready-to-commit"),
    );
    assert.equal(committing.stateRevision, 6);
    assert.ok(committing.cancellationUnsafeAt);
    await eventually(
      () =>
        observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%update%chats%'`,
      (rows) =>
        assert.equal(
          rows.length,
          1,
          "Actual placement UPDATE waits behind a real row lock",
        ),
      15000,
    );
    const [before] = await fixture.sql([], [stateQuery]);
    await visit(
      "unsafe cancellation rejected",
      "POST",
      `/api/chat-relocations/${job.id}/cancel`,
      { status: 409, json: { stateRevision: committing.stateRevision } },
    );
    const [after] = await fixture.sql([], [stateQuery]);
    assert.deepEqual(
      after,
      before,
      "Rejected cancellation does not mutate any durable resource during commit",
    );
    unlock.resolve();
    await transaction;
    const completed = await waitJob(job.id, "succeeded");
    await eventually(
      () => state.commands.slice(offset),
      (commands) =>
        assert.equal(
          commands.filter(
            (call) =>
              call.command.type === "chat.relocation.thread.release" &&
              call.command.discard === false,
          ).length,
          1,
        ),
    );
    await live.message(
      (frame) =>
        frame.type === "event" &&
        frame.resource === "chat-relocation-job" &&
        frame.entityId === job.id &&
        frame.revision === completed.stateRevision,
    );
    await live.ping("unsafe-cancellation-commit-completed");
    const [settled] = await fixture.sql([], [stateQuery]);
    assert.equal(
      settled.chats.find((chat) => chat.id === "chat").active_worker_id,
      "beta",
    );
    assert.ok(
      state.snapshots.get(job.id).threadId,
      "Committed target runtime remains hydrated",
    );
    return {
      actualPlacementUpdateBlocked: true,
      cancellationRejected: true,
      before: normal(fixture, before, "", startedAt),
      after: normal(fixture, after, "", startedAt),
      completed: normal(fixture, settled, "", startedAt),
    };
  } finally {
    state.hydrationBarrier = null;
    hydration.resolve();
    unlock.resolve();
    const cleanup = await Promise.allSettled([transaction]);
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const failed = cleanup.find((step) => step.status === "rejected");
    if (failed) throw failed.reason;
  }
}
