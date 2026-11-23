// Pause the real service, expire its lease, and execute production recovery
// through a separate repository process. No lifecycle state is assigned by SQL.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { repositoryFixture } from "./repository-fixture.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function relocationRecoveryFence(input) {
  const outcomes = [];
  for (const phase of ["reassigned", "queued"])
    outcomes.push(await expiredOwner(input, phase));
  return outcomes;
}

async function expiredOwner(
  {
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
    result,
    root,
    profile,
    repositoryExecutable,
  },
  phase,
) {
  await reset();
  state.mode = `expired-owner-${phase}-thread`;
  const repository = await repositoryFixture({
    kind: fixture.kind,
    executable: repositoryExecutable,
    root: path.join(root, profile, "recovery-repository"),
    databaseMode: "postgres",
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  let releaseOriginal,
    releaseReused,
    unlockClaim,
    claimTransaction,
    paused = false;
  const locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  state.hydrationReplyBarrier = new Promise((resolve) => {
    releaseOriginal = resolve;
  });
  state.reusedHydrationBarrier = new Promise((resolve) => {
    releaseReused = resolve;
  });
  const offset = state.commands.length,
    uploadOffset = state.uploads.length;
  try {
    const job = await visit(
      "expired owner admission",
      "POST",
      "/api/chats/chat/relocations",
      {
        status: 202,
        json: { target, approved: true, idempotencyKey: state.mode },
      },
    );
    const thread = await eventually(
      () => state.snapshots.get(job.id)?.threadId,
      (value) =>
        assert.ok(
          value,
          "Worker has already hydrated the target before its response is held",
        ),
    );
    const original = await read(`/api/chat-relocations/${job.id}`);
    assert.equal(original.state, "hydrating-runtime");
    assert.equal(original.attempt, 1);
    const [before] = await fixture.sql([], [stateQuery]);
    assert.equal(fixture.server.child.kill("SIGSTOP"), true);
    paused = true;
    await repository.seed(
      `UPDATE chat_relocation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${literal(job.id)}`,
    );
    const recovered = await repository.request({
      op: "relocation-recover",
      force: false,
      now: new Date().toISOString(),
    });
    assert.equal(recovered.rejected, false, JSON.stringify(recovered));
    assert.equal(
      recovered.value,
      1,
      "Actual production repository requeues the expired lease while its owner is interrupted",
    );
    if (phase === "queued") {
      let locked, rejected;
      const held = new Promise((resolve, reject) => {
        locked = resolve;
        rejected = reject;
      });
      const release = new Promise((resolve) => {
        unlockClaim = resolve;
      });
      claimTransaction = locker.begin(async (sql) => {
        await sql`SELECT id FROM chat_relocation_jobs WHERE id=${job.id} FOR UPDATE`;
        locked();
        await release;
      });
      claimTransaction.catch(rejected);
      await held;
    }
    fixture.server.child.kill("SIGCONT");
    paused = false;
    const oldFinished = () =>
      eventually(
        () => fixture.server.diagnostics(),
        (text) =>
          assert.ok(
            text
              .split("\n")
              .some(
                (line) =>
                  line.includes("Ignored stale chat relocation completion") &&
                  line.includes(job.id),
              ),
            "The actual stale owner finishes for this precise job",
          ),
        15000,
      );
    const discardCount = () =>
      state.commands
        .slice(offset)
        .filter(
          (call) =>
            call.command.type === "chat.relocation.thread.release" &&
            call.command.discard === true,
        ).length;
    let retainedBeforeRecoveryContinues;
    if (phase === "queued") {
      state.hydrationReplyBarrier = null;
      releaseOriginal();
      await oldFinished();
      const queued = await read(`/api/chat-relocations/${job.id}`);
      assert.equal(queued.state, "queued");
      assert.equal(queued.attempt, 1);
      retainedBeforeRecoveryContinues =
        discardCount() === 0 && state.snapshots.get(job.id).threadId === thread;
    }
    const replay = await visit(
      "expired owner idempotency wake",
      "POST",
      "/api/chats/chat/relocations",
      {
        status: 202,
        json: { target, approved: true, idempotencyKey: state.mode },
      },
    );
    assert.equal(replay.id, job.id);
    unlockClaim?.();
    await claimTransaction;
    await eventually(
      () => state.commands.slice(offset),
      (commands) =>
        assert.equal(
          commands.filter(
            (call) => call.command.type === "chat.relocation.hydration.begin",
          ).length,
          2,
        ),
    );
    const replacement = await eventually(
      () => read(`/api/chat-relocations/${job.id}`),
      (job) => {
        assert.equal(job.attempt, 2);
        assert.equal(job.state, "hydrating-runtime");
      },
    );
    assert.ok(replacement.stateRevision > original.stateRevision);
    if (phase === "reassigned") {
      state.hydrationReplyBarrier = null;
      releaseOriginal();
      await oldFinished();
      retainedBeforeRecoveryContinues =
        discardCount() === 0 && state.snapshots.get(job.id).threadId === thread;
    }
    const oldDiscards = state.commands
      .slice(offset)
      .filter(
        (call) =>
          call.command.type === "chat.relocation.thread.release" &&
          call.command.discard === true,
      );
    state.reusedHydrationBarrier = null;
    releaseReused();
    const completed = await waitJob(job.id, "succeeded");
    assert.equal(completed.attempt, 2);
    assert.equal(completed.targetRuntimeThreadId, thread);
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
    await live.ping("expired-owner-completed");
    const [after] = await fixture.sql([], [stateQuery]);
    assert.equal(after.jobs.length, 1);
    assert.equal(after.snapshots.length, 1);
    assert.deepEqual(
      after.snapshots[0],
      before.snapshots[0],
      "Recovery retains the same immutable encrypted snapshot",
    );
    assert.equal(
      after.chats.find((chat) => chat.id === "chat").active_worker_id,
      "beta",
    );
    assert.equal(
      state.uploads.length - uploadOffset,
      1,
      "New attempt reuses the hydrated target without uploading or reconstructing another thread",
    );
    assert.equal(
      state.commands
        .slice(offset)
        .filter(
          (call) => call.command.type === "chat.relocation.hydration.complete",
        ).length,
      1,
    );
    return {
      phase,
      recoveredCount: recovered.value,
      actualOwnerInterrupted: true,
      actualExpiredLeaseRecovered: true,
      attempt: completed.attempt,
      reusedSameThread: true,
      retainedBeforeRecoveryContinues,
      targetPreserved:
        retainedBeforeRecoveryContinues &&
        state.snapshots.get(job.id).threadId === thread,
      discardCount: oldDiscards.length,
      before: normal(fixture, before, "", startedAt),
      after: normal(fixture, after, "", startedAt),
      job: normal(fixture, completed, "", startedAt),
    };
  } finally {
    if (paused) fixture.server.child.kill("SIGCONT");
    state.hydrationReplyBarrier = null;
    state.reusedHydrationBarrier = null;
    releaseOriginal();
    releaseReused();
    unlockClaim?.();
    await Promise.allSettled([claimTransaction]);
    await locker.end({ timeout: 5 });
    (result.recoveryRepositoryDiagnostics ??= []).push({
      phase,
      diagnostics: repository.diagnostics(),
    });
    await repository.close();
  }
}
