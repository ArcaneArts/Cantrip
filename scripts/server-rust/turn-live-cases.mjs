import assert from "node:assert/strict";
import {
  retainedPrompt,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
import { eventPlan } from "./native-event-fixtures.mjs";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";
export async function runTurnLiveCases(h) {
  const { observe, seed, reset, owner, standalone } = h;
  const message = retainedPrompt().pendingMessage;
  const routing = { experience: "task", projectId: "github" };
  const runtime = {
    routeId: "gui-anchor",
    provider: { id: "gui-provider", name: "Live fixture" },
    model: { name: "Live model" },
  };
  const run = (name, step, fields = {}) =>
    observe(
      name,
      { chat: "chat", protectedMessage: message, ...fields, ...step },
      { op: "native-command-turn-live", shape: "raw" },
    );
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET protected_plan=NULL,has_pending_plan_question=false,plan_mode='default'",
    ]);
  };
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'plans',(SELECT jsonb_agg(jsonb_build_object('id',id,'planMode',plan_mode,'hasQuestion',has_pending_plan_question,'plan',protected_plan) ORDER BY id) FROM chats),'interactions',(SELECT jsonb_agg(to_jsonb(r)-'id' ORDER BY request_key) FROM agent_interaction_requests r)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  await clean();
  let values = await run(
    "live protected Agent write publishes the committed message",
    { action: "write", message },
  );
  for (const value of values) {
    assert.equal(value.results[0].id, message.id);
    assert.equal(value.events.length, 1);
    assert.equal(value.events[0].payload.id, message.id);
    assert.deepEqual(value.logs, []);
  }
  await snapshot("live Agent row keeps opaque content");
  const beforeReplay = await snapshot(
    "before Source encrypted append replay rejection",
  );
  values = await run(
    "encrypted append preserves Source JSONB metadata replay rejection",
    { action: "write", message },
    { captureErrors: true },
  );
  for (const value of values) {
    assert.deepEqual(value.results, [{ failed: true }]);
    assert.deepEqual(value.events, []);
  }
  assert.deepEqual(
    await snapshot("rejected encrypted append leaves actual rows unchanged"),
    beforeReplay,
  );
  values = await run("encrypted upsert republishes its real persisted result", {
    action: "write",
    message,
    upsert: true,
  });
  for (const value of values) assert.equal(value.events.length, 1);
  values = await run("live model attribution republishes committed metadata", {
    action: "route",
    messageId: message.id,
    modelId: "gui-model",
    runtime,
    reasoning: { appliedReasoningEffort: "high", reasoningAdjusted: true },
  });
  for (const value of values) {
    assert.equal(value.results[0].providerName, "Live fixture");
    assert.equal(value.events[0].payload.appliedReasoningEffort, "high");
  }
  await snapshot("actual model routing is persisted before publication");
  await clean();
  values = await run(
    "Task message notification precedes its chat and known project invalidations",
    { chat: "task", action: "write", kind: "task", message, routing },
  );
  for (const value of values) {
    assert.deepEqual(
      value.events.map((e) => [e.scope.kind, e.resource, e.action]),
      [
        ["chat", "chat-message", "updated"],
        ["chat", "task", "invalidated"],
        ["project", "task", "invalidated"],
      ],
    );
    assert.deepEqual(value.frames, [3]);
  }
  values = await run("Task model updates retain workload routing", {
    chat: "task",
    action: "route",
    kind: "task",
    messageId: message.id,
    modelId: "gui-model",
    runtime,
    routing,
  });
  for (const value of values) assert.equal(value.events.length, 3);
  await snapshot("actual Task messages and model metadata remain opaque");
  await clean();
  values = await run(
    "message publication failure cannot undo the committed encrypted Task row",
    { chat: "task", action: "write", kind: "task", message, routing },
    { failHub: true },
  );
  for (const value of values) {
    assert.equal(value.results[0].id, message.id);
    assert.equal(value.events.length, 1);
    assert.equal(value.events[0].scope.kind, "project");
    assert.deepEqual(
      value.logs.map((l) => l.message),
      [
        "Could not publish encrypted Task message",
        "Could not publish chat live invalidation",
      ],
    );
  }
  await snapshot("failed message publication leaves the durable row intact");
  await clean();
  values = await run(
    "disabled publishing still persists the real encrypted message",
    { action: "write", message },
    { enabled: false },
  );
  for (const value of values) {
    assert.equal(value.results[0].id, message.id);
    assert.deepEqual(value.events, []);
    assert.deepEqual(value.logs, []);
  }
  await snapshot("publishing flag does not suppress database writes");
  await clean();
  values = await run(
    "visible content is protected by the real worker contract before persistence",
    {
      action: "write",
      kind: "plain",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "private-worker-protection-marker" }],
        idempotencyKey: "visible-protected",
      },
    },
    {
      protectedMessage: {
        ...message,
        classification: { ...message.classification, role: "assistant" },
      },
    },
  );
  for (const value of values) {
    assert.equal(value.commands.length, 1);
    assert.equal(value.commands[0].command.type, "chat.message.protect");
    assert.equal(value.results[0].contextKind, "project");
    assert.deepEqual(
      value.results[0].protectedContent,
      message.protectedContent,
    );
    assert.deepEqual(
      value.events[0].payload.protectedContent,
      message.protectedContent,
    );
  }
  let states = await snapshot(
    "worker protection stores no visible content in the server",
  );
  for (const state of states) {
    assert.equal(state.messages[0].content, null);
    assert.ok(
      !JSON.stringify(state).includes("private-worker-protection-marker"),
    );
  }
  values = await run(
    "visible append replay returns before worker protection and publication",
    {
      action: "write",
      kind: "plain",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "changed ignored replay" }],
        idempotencyKey: "visible-protected",
      },
    },
    { connected: false },
  );
  for (const value of values) {
    assert.deepEqual(value.commands, []);
    assert.deepEqual(value.events, []);
    assert.ok(value.results[0]);
  }
  await run(
    "visible upsert still requires the actual worker",
    {
      action: "write",
      kind: "plain",
      upsert: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "edit" }],
        idempotencyKey: "visible-protected",
      },
    },
    { connected: false, captureErrors: true },
  ).then((v) => {
    for (const o of v) {
      assert.deepEqual(o.results, [{ failed: true }]);
      assert.deepEqual(o.events, []);
    }
  });
  await clean();
  values = await run(
    "explicit null attribution uses the normal current placement",
    { action: "write", message, attribution: null },
  );
  for (const value of values)
    assert.equal(value.results[0].worktreeId, "github-alpha-main");
  await clean();
  await seed(
    "ALTER TABLE chat_messages ADD CONSTRAINT reject_live_write CHECK(false)",
  );
  try {
    values = await run(
      "actual message INSERT failure emits no fabricated Live update",
      { action: "write", message },
      { captureErrors: true },
    );
    for (const value of values) {
      assert.deepEqual(value.results, [{ failed: true }]);
      assert.deepEqual(value.events, []);
    }
    states = await snapshot("message SQL rejection retains no row");
    for (const state of states) assert.equal(state.messages, null);
  } finally {
    await seed("ALTER TABLE chat_messages DROP CONSTRAINT reject_live_write");
  }
  await clean();
  for (const [chat, project, known] of [
    ["chat", "github", { experience: "agent", projectId: "github" }],
    ["task", "github", routing],
    [standalone, null, { experience: "agent", projectId: null }],
  ]) {
    values = await run("turn boundary event group " + chat, {
      chat,
      action: "boundary",
      projectId: project,
      routing: known,
    });
    for (const value of values) {
      assert.deepEqual(
        value.events.slice(0, 4).map((e) => e.resource),
        ["chat", "chat", "chat-goal", "chat-plan"],
      );
      assert.equal(value.frames[0], 4);
      assert.equal(value.events.length, chat === "task" ? 6 : 4);
      if (chat === "task")
        assert.deepEqual(
          value.events.slice(4).map((e) => e.resource),
          ["chat-goal", "chat-plan"],
        );
    }
  }
  values = await run(
    "Task routing lookups are discarded after their current invalidations settle",
    {
      chat: "task",
      steps: [
        { action: "boundary", projectId: "github" },
        {
          action: "boundary",
          projectId: "github",
          beforeSQL: "UPDATE chats SET archived_at=now() WHERE id='task'",
        },
      ],
    },
  );
  for (const value of values) assert.equal(value.events.length, 10);
  await clean();
  values = await run(
    "foreign owner routing does not fan out another tenant's Task",
    { chat: "task", action: "boundary", projectId: null },
    { owner: otherOwner },
  );
  for (const value of values) assert.equal(value.events.length, 4);
  values = await run("inference clear is an ephemeral scoped deletion", {
    action: "progress",
    progress: { kind: "clear", requestId: "live-request", sequence: 3 },
  });
  for (const value of values) {
    assert.equal(value.events[0].action, "deleted");
    assert.equal(value.events[0].payload, null);
    assert.equal(value.events[0].revision, 3);
  }
  values = await run(
    "inference publisher applies the generic bounded Live payload contract",
    {
      action: "progress",
      progress: { kind: "snapshot", requestId: "invalid", sequence: 0 },
    },
  );
  for (const value of values) {
    assert.equal(value.events.length, 1);
    assert.deepEqual(value.logs, []);
  }
  values = await run(
    "inference publication failure is logged without a fabricated event",
    {
      action: "progress",
      progress: { kind: "clear", requestId: "live-request", sequence: 4 },
    },
    { failHub: true },
  );
  for (const value of values) {
    assert.deepEqual(value.events, []);
    assert.equal(value.logs[0].message, "Could not publish inference progress");
  }
  await clean();
  values = await run(
    "protected Plan state and plan mode use the actual durable writers",
    {
      steps: [
        { action: "plan-mode", mode: "plan" },
        { action: "plan", plan: eventPlan },
        { action: "storage-plan" },
        { action: "plan-mode", mode: "default" },
        { action: "storage-plan" },
      ],
    },
  );
  for (const value of values) {
    assert.equal(value.results[0].mode, "plan");
    assert.deepEqual(value.results[2], eventPlan);
    assert.equal(value.results[3].state, null);
    assert.equal(value.results[3].hasQuestion, false);
    assert.equal(value.results[4], null);
  }
  await snapshot("default mode clears protected Plan state");
  values = await run(
    "standalone Plan mode rejection does not publish success",
    { chat: standalone, action: "plan-mode", mode: "plan" },
    { captureErrors: true },
  );
  for (const value of values) {
    assert.deepEqual(value.results, [{ failed: true }]);
    assert.deepEqual(value.events, []);
  }
  values = await run("missing owned Plan mode returns no result", {
    chat: "missing",
    action: "plan-mode",
    mode: "default",
  });
  for (const value of values) {
    assert.deepEqual(value.results, [null]);
    assert.deepEqual(value.events, []);
  }
  await clean();
  await seed(
    `UPDATE chats SET protected_plan=${literal(JSON.stringify(eventPlan))}::jsonb,has_pending_plan_question=${eventPlan.classification.hasQuestion ? "false" : "true"} WHERE id='chat'`,
  );
  values = await run(
    "inconsistent Plan metadata is rejected before a mode change",
    { action: "plan-mode", mode: "default" },
    { captureErrors: true },
  );
  for (const value of values)
    assert.deepEqual(value.results, [{ failed: true }]);
  await snapshot("failed Plan consistency check preserves the actual row");
  await clean();
  const attachment = deferredAttachment();
  await seed(
    `INSERT INTO chat_attachments(id,chat_id,worker_id,size_bytes,status,protected_metadata,created_at) VALUES(${literal(attachment.id)},'chat','alpha',3,'ready',${literal(JSON.stringify(attachment.protectedMetadata))}::jsonb,${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET worker_id='alpha'`,
  );
  values = await run(
    "prompt attachment order and duplicates use the real owned query",
    {
      action: "storage-attachments",
      context: { chatId: "chat", workerId: "alpha" },
      ids: [attachment.id, attachment.id],
    },
  );
  for (const value of values) {
    assert.equal(value.results[0].length, 2);
    assert.equal(value.results[0][0].workerId, "alpha");
  }
  for (const [name, context, ids] of [
    ["missing attachment", { chatId: "chat", workerId: "alpha" }, ["missing"]],
    ["foreign worker", { chatId: "chat", workerId: "beta" }, [attachment.id]],
  ]) {
    values = await run(
      "turn attachment rejection " + name,
      { action: "storage-attachments", context, ids },
      { captureErrors: true },
    );
    for (const value of values)
      assert.deepEqual(value.results, [{ failed: true }]);
  }
  await clean();
}
