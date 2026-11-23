// Restart the actual service against its existing database and enrolled workers.
import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import { json, literal, stamp, label } from "./project-target-state.mjs";

export async function relocationRestart({
  fixture,
  workers,
  state,
  live,
  setLive,
  reset,
  visit,
  read,
  waitJob,
  projectId,
  target,
  opaque,
  stateQuery,
  normal,
  startedAt,
  result,
}) {
  await reset();
  state.mode = "service-restart";
  await fixture.sql(["UPDATE chats SET status='running' WHERE id='chat'"]);
  const waiting = await visit(
    "restart waiting admission",
    "POST",
    "/api/chats/chat/relocations",
    {
      status: 202,
      json: { target, approved: true, idempotencyKey: "service-restart" },
    },
  );
  assert.equal(waiting.state, "waiting-for-idle");
  // Keep the job unavailable across bootstrap and both worker connections. Its
  // real wakeup is a public idempotency replay after the canonical chat is idle.
  await fixture.sql([
    `UPDATE chat_relocation_jobs SET available_at='2099-01-01T00:00:00.000Z' WHERE id=${literal(waiting.id)}`,
  ]);
  const [before] = await fixture.sql([], [stateQuery]);
  assert.equal(
    Date.parse(before.jobs[0].available_at),
    Date.parse("2099-01-01T00:00:00.000Z"),
  );
  assert.equal(before.snapshots[0].message_count, 1);
  const port = Number(new URL(fixture.server.origin).port);
  const recoveryStartedAt = Date.now();
  for (const worker of workers) worker.close();
  await live.close();
  result.restartShutdown = { diagnostics: fixture.server.diagnostics() };
  await fixture.close();
  result.restartShutdown.clean = true;
  await fixture.start({ port });
  const reopened = await visit(
    "restart retained waiting job",
    "GET",
    `/api/chat-relocations/${waiting.id}`,
  );
  assert.deepEqual(
    reopened,
    waiting,
    "The actual service reopen preserves the durable job and identity",
  );
  const [reopenedState] = await fixture.sql([], [stateQuery]);
  const recoveredChat = reopenedState.chats.find((chat) => chat.id === "chat");
  assert.equal(
    recoveredChat.status,
    "idle",
    "Restart recovers the interrupted chat to idle",
  );
  assert.equal(
    recoveredChat.has_unread_completion,
    true,
    "Interrupted execution is surfaced to the client",
  );
  assert.ok(
    Date.parse(recoveredChat.updated_at) >= recoveryStartedAt &&
      Date.parse(recoveredChat.updated_at) <= Date.now(),
  );
  const expectedReopened = structuredClone(before);
  expectedReopened.chats = expectedReopened.chats.map((chat) =>
    chat.id === "chat"
      ? {
          ...chat,
          status: "idle",
          has_unread_completion: true,
          updated_at: recoveredChat.updated_at,
        }
      : chat,
  );
  assert.deepEqual(
    reopenedState,
    expectedReopened,
    "Reopen preserves every resource except the exact interrupted-chat recovery transition",
  );
  const nextLive = new LiveProbe(fixture);
  setLive(nextLive);
  await nextLive.open();
  await nextLive.initialized();
  await nextLive.subscribed("restart-scopes", [
    currentUser,
    { kind: "project", projectId },
    { kind: "chat", chatId: "chat" },
  ]);
  for (const worker of workers) await worker.start();
  const commandOffset = state.commands.length,
    uploadOffset = state.uploads.length;
  await fixture.sql([
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES('after-service-restart','chat','github-alpha-main','user','default',${json(opaque)},'[]',false,'after-service-restart',${literal(stamp)})`,
    "UPDATE chats SET status='idle' WHERE id='chat'",
    `UPDATE chat_relocation_jobs SET available_at=now() WHERE id=${literal(waiting.id)}`,
  ]);
  // A connection callback can concurrently start dispatch. Validate its exact
  // identity without comparing a transient state across independent runtimes.
  await fixture.observe(
    "restart idempotency wake",
    "POST",
    "/api/chats/chat/relocations",
    {
      status: 202,
      csrf: !!fixture.client().csrf,
      json: { target, approved: true, idempotencyKey: "service-restart" },
    },
  );
  assert.equal(fixture.records.get("restart idempotency wake").id, waiting.id);
  const settled = await waitJob(waiting.id, "succeeded");
  assert.equal(settled.attempt, 1);
  await nextLive.message(
    (frame) =>
      frame.type === "event" &&
      frame.resource === "chat-relocation-job" &&
      frame.entityId === waiting.id &&
      frame.revision === settled.stateRevision,
  );
  await eventually(
    () => state.commands.slice(commandOffset),
    (commands) =>
      assert.ok(
        commands.some(
          (call) =>
            call.command.type === "chat.relocation.thread.release" &&
            call.worker === "alpha" &&
            call.command.discard === false,
        ),
      ),
  );
  await nextLive.ping("restart-completed");
  const [after] = await fixture.sql([], [stateQuery]);
  assert.equal(after.jobs.length, 1);
  assert.equal(after.snapshots.length, 1);
  assert.equal(after.snapshots[0].job_id, waiting.id);
  assert.equal(
    after.snapshots[0].message_count,
    2,
    "Waiting relocation refreshes its canonical snapshot after restart",
  );
  assert.equal(
    after.snapshots[0].payload.messages[1].id,
    "after-service-restart",
  );
  assert.notEqual(
    after.snapshots[0].transcript_sha256,
    before.snapshots[0].transcript_sha256,
  );
  assert.deepEqual(
    state.uploads[uploadOffset].payload,
    after.snapshots[0].payload,
  );
  assert.equal(
    after.chats.find((chat) => chat.id === "chat").active_worker_id,
    "beta",
  );
  const current = await read(`/api/chat-relocations/${waiting.id}`);
  assert.deepEqual(current, settled);
  const commands = state.commands.slice(commandOffset);
  assert.equal(commands[0].command.type, "worktree.status");
  assert.equal(commands[1].command.type, "worktree.status");
  commands.splice(
    0,
    2,
    ...commands.slice(0, 2).sort((a, b) => a.worker.localeCompare(b.worker)),
  );
  return {
    before: normal(fixture, before, "", startedAt),
    reopened: normal(fixture, reopenedState, "", startedAt),
    after: normal(fixture, after, "", startedAt),
    job: normal(fixture, settled, "", startedAt),
    commands: normal(fixture, commands, "", startedAt),
    uploads: normal(fixture, state.uploads.slice(uploadOffset), "", startedAt),
    cleanShutdown: true,
  };
}

export async function relocationConcurrency({
  fixture,
  state,
  live,
  reset,
  visit,
  waitJob,
  owner,
  projectId,
  target,
  opaque,
  stateQuery,
  normal,
  startedAt,
}) {
  await reset();
  state.mode = "concurrency-and-renewal";
  state.concurrentThreads = true;
  let release;
  state.hydrationBarrier = new Promise((resolve) => {
    release = resolve;
  });
  const commandOffset = state.commands.length;
  const chats = ["chat", "concurrent-b", "concurrent-c"];
  const jobsQuery =
    "SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY chat_id),'[]')::text AS result FROM chat_relocation_jobs j";
  const readJobs = async () => (await fixture.sql([], [jobsQuery]))[0];
  const order = (state) => {
    const snapshot = structuredClone(state);
    const chatByJob = new Map(
      snapshot.jobs.map((job) => [job.id, job.chat_id]),
    );
    const chatByLane = new Map(
      snapshot.lanes.map((lane) => [lane.id, lane.chat_id]),
    );
    const key = (name, row) =>
      name === "leases"
        ? [
            chatByLane.get(row.chat_execution_lane_id),
            row.branch_name,
            row.worktree_id,
            row.worker_id,
          ].join(":")
        : name === "snapshots"
          ? chatByJob.get(row.job_id)
          : [row.chat_id, row.worktree_id, row.worker_id].join(":");
    for (const name of ["jobs", "snapshots", "sessions", "lanes", "leases"])
      snapshot[name]?.sort((a, b) => key(name, a).localeCompare(key(name, b)));
    return snapshot;
  };
  try {
    await fixture.sql(
      chats
        .slice(1)
        .flatMap((chat) => [
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,model_id,permission_profile_id,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(chat)},${literal(owner)},${literal(projectId)},'github-alpha-main','alpha','relocation-model','permission',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES(${literal(chat + "-message")},${literal(chat)},'github-alpha-main','user','default',${json(opaque)},'[]',false,${literal(chat + "-message")},${literal(stamp)})`,
        ]),
    );
    const admitted = [];
    for (const chat of chats)
      admitted.push(
        await visit(
          "concurrent admit " + chat,
          "POST",
          `/api/chats/${chat}/relocations`,
          {
            status: 202,
            json: {
              target,
              approved: true,
              idempotencyKey: "concurrent-" + chat,
            },
          },
        ),
      );
    await eventually(
      () => state.commands.slice(commandOffset),
      (commands) =>
        assert.equal(
          commands.filter(
            (call) => call.command.type === "chat.relocation.hydration.begin",
          ).length,
          2,
        ),
    );
    const [initial] = await fixture.sql([], [stateQuery]);
    const running = initial.jobs.filter(
      (job) => job.state === "hydrating-runtime",
    );
    assert.equal(
      running.length,
      2,
      "Two actual jobs own active hydration requests",
    );
    assert.equal(
      initial.jobs.filter((job) => job.state === "queued" && job.attempt === 0)
        .length,
      1,
      "Third admitted job remains queued at the concurrency limit",
    );
    assert.ok(
      initial.jobs.every(
        (job) => job.state === "queued" || job.state === "hydrating-runtime",
      ),
    );
    const initialLeases = new Map(running.map((job) => [job.id, job]));
    await eventually(
      readJobs,
      (jobs) => {
        assert.equal(jobs.length, 3);
        assert.equal(
          state.commands
            .slice(commandOffset)
            .filter(
              (call) => call.command.type === "chat.relocation.hydration.begin",
            ).length,
          2,
          "A third hydration must not start while both slots are held",
        );
        assert.equal(
          jobs.filter((job) => job.state === "queued" && job.attempt === 0)
            .length,
          1,
        );
        for (const job of jobs.filter((job) => initialLeases.has(job.id))) {
          const previous = initialLeases.get(job.id);
          assert.equal(job.command_id, previous.command_id);
          assert.equal(job.attempt, 1);
          assert.equal(job.state, "hydrating-runtime");
          assert.equal(
            Date.parse(job.lease_expires_at) - Date.parse(job.updated_at),
            120000,
          );
          assert.ok(
            Date.parse(job.lease_expires_at) >=
              Date.parse(previous.lease_expires_at) + 25000,
            "Real 30-second timer renews the same fenced lease",
          );
        }
      },
      50000,
    );
    const [renewed] = await fixture.sql([], [stateQuery]);
    state.hydrationBarrier = null;
    release();
    for (const job of admitted) await waitJob(job.id, "succeeded");
    await eventually(
      () => state.commands.slice(commandOffset),
      (commands) =>
        assert.equal(
          commands.filter(
            (call) =>
              call.command.type === "chat.relocation.thread.release" &&
              !call.command.discard,
          ).length,
          1,
        ),
    );
    await live.ping("concurrency-completed");
    const [completed] = await fixture.sql([], [stateQuery]);
    assert.equal(completed.jobs.length, 3);
    assert.equal(completed.leases.length, 3);
    const completedLanes = new Map(
      completed.lanes.map((lane) => [lane.id, lane]),
    );
    assert.deepEqual(
      completed.leases
        .map((lease) => {
          assert.equal(lease.state, "released");
          assert.equal(lease.branch_name, "main");
          assert.equal(lease.worker_id, "beta");
          assert.equal(lease.worktree_id, "github-beta-main");
          const lane = completedLanes.get(lease.chat_execution_lane_id);
          assert.ok(lane);
          return lane.chat_id;
        })
        .sort(),
      chats.toSorted(),
      "Every generated branch lease retains its exact owning chat and lane",
    );
    assert.ok(
      completed.jobs.every(
        (job) =>
          job.state === "succeeded" &&
          job.attempt === 1 &&
          job.command_id === null &&
          job.lease_expires_at === null,
      ),
    );
    assert.ok(
      completed.chats
        .filter((chat) => chats.includes(chat.id))
        .every(
          (chat) =>
            chat.active_worker_id === "beta" && chat.placement_revision === 2,
        ),
    );
    const commands = state.commands.slice(commandOffset);
    assert.equal(
      commands.filter(
        (call) =>
          call.command.type === "worktree.status" && call.worker === "alpha",
      ).length,
      3,
    );
    assert.equal(
      commands.filter(
        (call) =>
          call.command.type === "worktree.status" && call.worker === "beta",
      ).length,
      6,
    );
    const perJob = [];
    for (const job of admitted) {
      const calls = commands.filter(
        (call) => call.command.snapshotId === job.id,
      );
      assert.deepEqual(
        calls.map((call) => call.command.type),
        [
          "chat.relocation.hydration.begin",
          "chat.relocation.hydration.chunk",
          "chat.relocation.hydration.complete",
        ],
      );
      perJob.push({ chat: job.chatId, commands: calls });
    }
    return {
      initial: normal(fixture, order(initial), "", startedAt),
      renewed: normal(fixture, order(renewed), "", startedAt),
      completed: normal(fixture, order(completed), "", startedAt),
      commands: normal(fixture, perJob, "", startedAt),
      concurrency: 2,
      actualLeaseRenewal: true,
    };
  } finally {
    state.hydrationBarrier = null;
    release();
    state.concurrentThreads = false;
  }
}
