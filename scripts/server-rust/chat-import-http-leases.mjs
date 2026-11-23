import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

// Hold real worker requests across the production 30-second renewal interval.
export async function importLeases({
  fixture,
  state,
  live,
  projectId,
  sourceId,
  visit,
  waitJob,
  sqlState,
  finishEvents,
  normalState,
  workerCommands,
  normal,
  result,
}) {
  let release;
  state.mode = "success";
  state.withAttachments = false;
  state.messageCount = 2;
  state.readBarrier = new Promise((resolve) => {
    release = resolve;
  });
  const commandOffset = state.commands.length;
  await live.ping("before lease test");
  const eventOffset = live.history.length;
  let jobs;
  try {
    jobs = await visit(
      "concurrent leased imports",
      "POST",
      "/api/projects/" + projectId + "/chat-imports",
      {
        status: 202,
        json: {
          imports: ["a", "b", "c"].map((name) => ({
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "alpha",
            sourceId,
            sourceThreadId: "lease-" + name,
            idempotencyKey: "lease-" + name,
            target: {
              kind: "worktree",
              projectId,
              worktreeId: "github-beta-main",
            },
            modelId: null,
          })),
        },
      },
    );
    assert.equal(jobs.length, 3);
    const ids = new Set(jobs.map((j) => j.id));
    const rows = async () =>
      (await sqlState()).jobs.filter((j) => ids.has(j.id));
    const initial = await eventually(rows, (current) => {
      assert.equal(current.filter((j) => j.state === "reading").length, 2);
      assert.equal(current.filter((j) => j.state === "queued").length, 1);
      assert.equal(
        state.commands
          .slice(commandOffset)
          .filter((c) => c.command.type === "external.chat-history.read")
          .length,
        2,
      );
    });
    const running = initial.filter((j) => j.state === "reading");
    const renewed = await eventually(
      rows,
      (current) => {
        assert.equal(current.filter((j) => j.state === "reading").length, 2);
        assert.equal(current.filter((j) => j.state === "queued").length, 1);
        assert.equal(
          state.commands
            .slice(commandOffset)
            .filter((c) => c.command.type === "external.chat-history.read")
            .length,
          2,
          "Third request remains queued while both permits are held",
        );
        for (const before of running) {
          const after = current.find((j) => j.id === before.id);
          assert.equal(after.command_id, before.command_id);
          assert.equal(after.attempt, before.attempt);
          assert.equal(after.state_revision, before.state_revision);
          assert.ok(
            Date.parse(after.lease_expires_at) -
              Date.parse(before.lease_expires_at) >=
              20000,
            "Actual periodic renewal extends the durable lease without replacing its owner",
          );
        }
      },
      45000,
    );
    // End the simultaneous reads with a controlled failure. Canonical writes
    // are retried in admission order below, so their global SQL sequences and
    // pane positions have the same causal order in both isolated databases.
    state.mode = "read-error";
    release();
    state.readBarrier = undefined;
    const blocked = await Promise.all(
      jobs.map((j) => waitJob(j.id, "blocked")),
    );
    for (const job of blocked) {
      assert.equal(job.chatId, null);
      assert.deepEqual(job.error, { code: "worker-error", retryable: true });
    }
    assert.equal(
      state.commands
        .slice(commandOffset)
        .filter((c) => c.command.type === "external.chat-history.read").length,
      3,
    );
    state.mode = "success";
    const completed = [];
    for (const job of blocked) {
      await visit(
        "retry leased import " + job.sourceThreadId,
        "POST",
        "/api/chat-imports/" + job.id + "/retry",
        { json: { stateRevision: job.stateRevision } },
      );
      completed.push(await waitJob(job.id, "succeeded"));
    }
    for (const job of completed) {
      await finishEvents(job);
      assert.equal(job.attempt, 3);
      assert.equal(job.stateRevision, 9);
      assert.equal(job.managedThreadId, null);
    }
    const after = await sqlState();
    const normalizedState = normalState(after);
    for (const job of completed) {
      assert.equal(after.chats.filter((c) => c.id === job.id).length, 1);
      assert.equal(
        after.messages.filter((m) => m.chat_id === job.id).length,
        2,
      );
    }
    const commands = state.commands.slice(commandOffset);
    assert.equal(
      commands.filter((c) => c.command.type === "external.chat-history.read")
        .length,
      6,
    );
    const events = live.history
      .slice(eventOffset)
      .filter(
        (e) =>
          e.type === "event" &&
          ["chat-import-job", "project", "chat"].includes(e.resource),
      );
    for (const [i, event] of events.entries())
      if (event.resource === "chat-import-job" && ids.has(event.entityId)) {
        const count = event.revision >= 7 ? 3 : 2;
        assert.deepEqual(
          events.slice(i, i + count).map((e) => e.resource),
          ["chat-import-job", "project", ...(count === 3 ? ["chat"] : [])],
          "Concurrent imports retain each synchronous publication batch",
        );
      }
    result.leases = {
      comparable: {
        jobs: normal(completed),
        state: normalizedState,
        commandsByJob: completed.map((job) => ({
          jobId: normal(job.id),
          commands: workerCommands(
            commands.filter(
              ({ command }) =>
                command.chatId === job.id ||
                command.messages?.some((m) =>
                  after.messages.some(
                    (row) => row.id === m.id && row.chat_id === job.id,
                  ),
                ),
            ),
          ),
        })),
        jobEvents: completed.map((job) =>
          normal(
            events
              .filter(
                (e) =>
                  e.resource === "chat-import-job" && e.entityId === job.id,
              )
              .map(
                ({ scope, resource, action, entityId, revision, payload }) => ({
                  scope,
                  resource,
                  action,
                  entityId,
                  revision,
                  payload,
                }),
              ),
          ),
        ),
      },
      raw: { initial, renewed, blocked, after, commands, events },
    };
  } finally {
    release();
    state.readBarrier = undefined;
  }
}
