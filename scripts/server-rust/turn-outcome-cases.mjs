import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
import {
  taskEnvelope,
  taskMessage,
  taskStart,
  taskResult,
  taskContent,
} from "./task-wire-fixtures.mjs";

export async function runTurnOutcomeCases(h) {
  const {
    observe,
    seed,
    reset,
    owner,
    reopen,
    standalone,
    scratch,
    registerFixedClock,
  } = h;
  const id = (n) => `85858585-8585-4858-8858-${String(n).padStart(12, "0")}`;
  const lane = id(1),
    user = id(2),
    assistant = id(3),
    operation = id(4),
    cycle = id(5);
  const protectedMessage = retainedPrompt().pendingMessage;
  const encrypted = {
    ...protectedMessage,
    id: assistant,
    idempotencyKey: `assistant:${user}`,
    classification: { ...protectedMessage.classification, role: "assistant" },
  };
  const sqlRows =
    "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c WHERE id IN ('chat','task'," +
    literal(standalone) +
    ")),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'sessions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM chat_runtime_sessions r),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY chat_id,sequence) FROM chat_messages m),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,ordinal) FROM task_planning_rounds r),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'logical',(SELECT jsonb_agg(to_jsonb(c) ORDER BY root_operation_id) FROM native_logical_completions c)) result";
  const result = (fields = {}) => ({
    threadId: "outcome-thread",
    turnId: "outcome-turn",
    status: "completed",
    text: "",
    ...fields,
  });
  const note = (chat = "chat", fields = {}) => ({
    type: "chat.turn.outcome",
    chatId: chat,
    clientMessageId: user,
    executionLaneId: lane,
    contextKind: chat === standalone ? "standalone" : "project",
    worktreeId: chat === standalone ? null : "github-alpha-main",
    scratchRootId: chat === standalone ? scratch : null,
    outcome: { ok: true, result: result() },
    ...fields,
  });
  const recover = (notification, fields = {}) => ({
    kind: "recover",
    notification,
    ...fields,
  });
  const run = (name, notification, fields = {}) =>
    observe(
      name,
      {
        chat: notification?.chatId ?? "chat",
        protectedMessage,
        steps: [recover(notification), { kind: "drain" }],
        ...fields,
      },
      { op: "native-command-turn-outcome", shape: "raw" },
    );
  const rows = (name) =>
    observe(name, { sql: sqlRows }, { op: "query-json", shape: "raw" });
  const successes = (v) => {
    assert.equal(v.beginError, null);
    assert.deepEqual(v.result.snapshots[0].recoveryErrors, [null]);
  };
  const state = (r, chat = "chat") => r.chats.find((c) => c.id === chat);
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('outcome-provider',${literal(owner)},'Outcome','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('outcome-model',${literal(owner)},'Outcome') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('outcome-route','outcome-model','outcome-provider','outcome',0,true) ON CONFLICT DO NOTHING",
  ]);
  async function clean({
    chat = "chat",
    state = "active",
    withUser = true,
    paused = false,
  } = {}) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM chat_messages",
      "DELETE FROM token_usage_records",
      "DELETE FROM model_behavior_observations",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET model_id='outcome-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL,auto_title_pending=false,protected_plan=NULL,has_pending_plan_question=false,automation_paused=false",
      "UPDATE chats SET experience='agent' WHERE id='chat'",
      "UPDATE chats SET experience='task' WHERE id='task'",
      "UPDATE user_settings SET default_model_id='outcome-model',auto_name_tasks=false,auto_name_chats=false",
      `UPDATE chats SET status='running',automation_paused=${paused} WHERE id=${literal(chat)}`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,scratch_root_id,codex_thread_id,model_route_id,status,created_at,updated_at) VALUES('${id(10)}',${literal(chat)},'alpha',${literal(chat === standalone ? null : "github-alpha-main")},${literal(chat === standalone ? scratch : null)},'outcome-thread','outcome-route','running',${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,codex_thread_id,created_at,activated_at,updated_at) VALUES('${lane}',${literal(chat)},${literal(chat === standalone ? null : "github-alpha-main")},${literal(chat === standalone ? scratch : null)},'alpha','user',true,'Saved outcome',${literal(state)},'${id(10)}','outcome-thread',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      ...(withUser
        ? [
            `INSERT INTO chat_messages(id,chat_id,worktree_id,scratch_root_id,execution_lane_id,role,mode,protected_content,idempotency_key,created_at) VALUES('${user}',${literal(chat)},${literal(chat === standalone ? null : "github-alpha-main")},${literal(chat === standalone ? scratch : null)},'${lane}','user','default',${json(protectedMessage.protectedContent)},'outcome-user',${literal(stamp)})`,
          ]
        : []),
      ...(chat === "task"
        ? [
            `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
          ]
        : []),
    ]);
  }
  for (const [name, fields, options, worker] of [
    ["absent execution lane", { executionLaneId: id(99) }, {}, "alpha"],
    ["different physical worker", {}, {}, "beta"],
    ["different project root", { worktreeId: "github-beta-main" }, {}, "alpha"],
    [
      "different context root",
      { contextKind: "standalone", worktreeId: null, scratchRootId: scratch },
      {},
      "alpha",
    ],
    ["released execution lane", {}, { state: "released" }, "alpha"],
  ]) {
    await clean(options);
    const before = await rows("before ignored " + name);
    for (const v of await run(
      "saved outcome rejects " + name,
      note("chat", fields),
      { steps: [recover(note("chat", fields), { worker }), { kind: "drain" }] },
    )) {
      successes(v);
      assert.equal(v.commands.length, 0);
      assert.equal(v.events.length, 0);
      assert.equal(
        v.logs[0].message,
        "Ignored an agent turn outcome outside its execution lane",
      );
    }
    assert.deepEqual(
      await rows("ignored outcome preserves exact durable rows " + name),
      before,
    );
  }
  await clean();
  {
    const before = await rows("before wrong-owner outcome");
    for (const v of await run(
      "another owner cannot recover this saved result",
      note(),
      { steps: [recover(note(), { owner: otherOwner }), { kind: "drain" }] },
    )) {
      successes(v);
      assert.equal(v.commands.length, 0);
      assert.equal(v.events.length, 0);
    }
    assert.deepEqual(
      await rows("wrong-owner recovery leaves exact rows untouched"),
      before,
    );
  }
  await clean();
  await seed(
    `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,protected_content,idempotency_key,created_at) VALUES('${id(20)}','chat','github-alpha-main','${lane}','user','default',${json(protectedMessage.protectedContent)},'outcome-newer',${literal(stamp)})`,
  );
  for (const v of await run(
    "late result cannot overwrite a newer user turn on the same lane",
    note(),
  )) {
    successes(v);
    assert.equal(v.commands.length, 0);
    assert.equal(
      v.logs[0].message,
      "Ignored a stale agent turn outcome after the execution lane advanced",
    );
  }

  for (const withUser of [true, false]) {
    await clean({ withUser });
    for (const v of await run(
      "project Agent saved result uses actual worker protection, withUser=" +
        withUser,
      note("chat", {
        outcome: { ok: true, result: result({ text: "saved 😀 \ud800" }) },
      }),
    )) {
      successes(v);
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        ["chat.message.protect"],
      );
      assert.equal(
        v.commands[0].command.message.content[0].text,
        "saved 😀 \ud800",
      );
      assert.equal(
        v.logs.at(-1).responseCharacterCount,
        "saved 😀 \ud800".length,
      );
    }
    for (const r of await rows(
      "protected project result suspends lane and idles Chat " + withUser,
    )) {
      assert.equal(state(r).status, "idle");
      assert.equal(r.lanes[0].state, "suspended");
      assert.equal(r.messages.length, withUser ? 2 : 1);
      assert.ok(r.messages.every((m) => m.content === null));
    }
  }
  let before = await rows(
    "protected Agent completion exact rows before restart",
  );
  await reopen("saved Agent result restart");
  assert.deepEqual(
    await rows("protected Agent completion exact rows after restart"),
    before,
  );
  for (const v of await run(
    "duplicate saved result is ignored after actual lane suspension",
    note(),
  )) {
    successes(v);
    assert.equal(v.commands.length, 0);
  }

  await clean();
  for (const v of await run(
    "worker failure persists protected system message with exact UTF16 reason",
    note("chat", {
      outcome: { ok: false, error: "worker \udfff interrupted" },
    }),
  )) {
    successes(v);
    assert.equal(
      v.commands[0].command.message.content[0].text,
      "Agent failed: worker \udfff interrupted",
    );
    assert.equal(v.commands[0].command.message.role, "system");
    assert.equal(v.logs.at(-1).outcome, "failed");
  }
  for (const r of await rows(
    "worker failure suspends lane and preserves protected error identity",
  )) {
    assert.equal(state(r).status, "failed");
    assert.equal(r.messages.at(-1).idempotency_key, `error:${user}`);
    assert.equal(r.messages.at(-1).content, null);
  }
  await clean();
  for (const v of await run(
    "empty recovered response retains Source completion fallback",
    note(),
  )) {
    successes(v);
    assert.equal(
      v.commands[0].command.message.content[0].text,
      "The agent completed without a message.",
    );
  }
  await clean();
  await seed([
    `CREATE OR REPLACE FUNCTION outcome_concurrent_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='assistant' THEN UPDATE chat_execution_lanes SET state='released',released_at=${literal(stamp)} WHERE id='${lane}'; UPDATE chats SET status='failed' WHERE id='chat'; END IF; RETURN NEW; END $$`,
    "CREATE TRIGGER outcome_concurrent_finish AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION outcome_concurrent_finish()",
  ]);
  for (const v of await run(
    "saved success repairs failed Chat after concurrent lane release",
    note(),
  ))
    successes(v);
  await seed([
    "DROP TRIGGER outcome_concurrent_finish ON chat_messages",
    "DROP FUNCTION outcome_concurrent_finish()",
  ]);
  for (const r of await rows(
    "concurrent release preserves released lane and restores successful Chat",
  )) {
    assert.equal(r.lanes[0].state, "released");
    assert.equal(state(r).status, "idle");
  }

  await clean();
  const queued = retainedPrompt({ modelId: "outcome-model" });
  queued.id = id(40);
  queued.idempotencyKey = "outcome-followup-prompt";
  queued.pendingMessage.id = id(41);
  queued.pendingMessage.idempotencyKey = "outcome-followup-user";
  queued.nativeClientUserMessageId = "cantrip:" + id(41);
  await observe(
    "enqueue actual protected input before saved outcome recovery",
    { action: "create-encrypted", chat: "chat", content: queued },
    { op: "native-command-prompt-run", shape: "raw" },
  );
  const queuedAssistant = {
    ...protectedMessage,
    id: "<task-response-id>",
    idempotencyKey: "<task-response-key>",
    classification: { ...protectedMessage.classification, role: "assistant" },
  };
  for (const v of await run(
    "recovered result dispatches real retained queue through actual turn engine",
    note(),
    {
      queueAdmission: {
        ownerId: owner,
        chatId: "chat",
        promptId: queued.id,
        pendingMessage: queued.pendingMessage,
      },
      steps: [
        recover(note()),
        { kind: "drain" },
        {
          kind: "snapshot",
          sql: "SELECT jsonb_build_object('queueAdmissions',(SELECT jsonb_agg(jsonb_build_object('claim',to_jsonb(c),'input',s.protected_input) ORDER BY c.id) FROM managed_queue_claims c JOIN managed_queue_input_snapshots s ON s.claim_id=c.id)) result",
        },
      ],
      attempts: [
        {
          templateResult: true,
          result: result({
            turnId: "outcome-queued-turn",
            structuredResult: { message: queuedAssistant },
          }),
        },
      ],
    },
  )) {
    successes(v);
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
    assert.ok(v.logs.some((l) => l.event === "chat.queue.dispatching"));
  }
  for (const r of await rows(
    "recovered result and queued turn retain all actual encrypted messages",
  )) {
    assert.equal(r.messages.length, 4);
    assert.equal(state(r).status, "idle");
    assert.ok(r.messages.every((m) => m.content === null));
    assert.ok(r.messages.some((m) => m.id === id(41)));
  }

  await clean({ chat: standalone });
  for (const v of await run(
    "standalone saved outcome persists existing encrypted worker message",
    note(standalone, {
      outcome: {
        ok: true,
        result: result({ structuredResult: { message: encrypted } }),
      },
    }),
  )) {
    successes(v);
    assert.equal(v.commands.length, 0);
  }
  for (const r of await rows(
    "standalone outcome preserves scratch attribution and opaque content",
  )) {
    const message = r.messages.at(-1);
    assert.equal(message.scratch_root_id, scratch);
    assert.equal(message.worktree_id, null);
    assert.equal(state(r, standalone).status, "idle");
    assert.deepEqual(message.protected_content, encrypted.protectedContent);
  }
  before = await rows("standalone encrypted outcome before restart");
  await reopen("standalone saved outcome restart");
  assert.deepEqual(
    await rows("standalone encrypted outcome exact rows after restart"),
    before,
  );
  for (const structuredResult of [{ message: null }, {}]) {
    await clean({ chat: standalone });
    for (const v of await run(
      "invalid standalone result remains unacknowledged " +
        JSON.stringify(structuredResult),
      note(standalone, {
        outcome: { ok: true, result: result({ structuredResult }) },
      }),
    )) {
      assert.equal(v.beginError, null);
      assert.ok(v.result.snapshots[0].recoveryErrors[0]);
      assert.equal(v.commands.length, 0);
    }
    for (const r of await rows(
      "standalone invalid result retains active lane " +
        JSON.stringify(structuredResult),
    )) {
      assert.equal(r.lanes[0].state, "active");
      assert.equal(state(r, standalone).status, "running");
      assert.equal(r.messages.length, 1);
    }
  }
  await clean({ chat: standalone });
  for (const v of await run(
    "standalone worker failure preserves opaque-only history",
    note(standalone, { outcome: { ok: false, error: "lost worker" } }),
  )) {
    successes(v);
    assert.equal(v.commands.length, 0);
  }
  for (const r of await rows("standalone failure never appends plaintext")) {
    assert.equal(r.messages.length, 1);
    assert.equal(state(r, standalone).status, "failed");
  }

  await clean({ chat: "task" });
  const taskAssistant = taskMessage("assistant", "goal", assistant);
  taskAssistant.idempotencyKey = `assistant:${user}`;
  for (const v of await run(
    "resident Task Goal outcome writes actual encrypted Task message",
    note("task", {
      outcome: {
        ok: true,
        result: result({ structuredResult: { message: taskAssistant } }),
      },
    }),
  )) {
    successes(v);
    assert.equal(v.commands.length, 0);
  }
  for (const r of await rows("resident Task Goal output remains protected")) {
    assert.equal(state(r, "task").status, "idle");
    assert.deepEqual(r.messages.at(-1).task_protected_content, taskEnvelope);
    assert.equal(r.messages.at(-1).content, null);
  }
  await clean({ chat: "task" });
  for (const v of await run(
    "malformed resident Goal result marks recovered failure",
    note("task", {
      outcome: { ok: true, result: result({ structuredResult: {} }) },
    }),
  )) {
    successes(v);
    assert.equal(v.logs.at(-1).status, "failed");
    assert.equal(v.logs.at(-1).outcome, "completed");
  }
  for (const r of await rows(
    "invalid resident Task message is absent after failed recovery",
  )) {
    assert.equal(r.messages.length, 1);
    assert.equal(state(r, "task").status, "failed");
  }

  for (const kind of ["success", "malformed", "failure"]) {
    await clean({ chat: "task" });
    const prepared = taskStart("direct", "task", 1, 1, operation),
      relay = taskResult(prepared);
    await observe(
      "begin actual Task operation for saved outcome " + kind,
      { chat: "task", action: "begin", input: prepared },
      { op: "native-command-task", shape: "raw" },
    );
    await seed(
      `UPDATE task_planning_rounds SET execution_lane_id='${lane}',user_message_id='${user}' WHERE id='${operation}'`,
    );
    const outcome =
      kind === "failure"
        ? { ok: false, error: "worker failed" }
        : {
            ok: true,
            result: result({
              structuredResult: kind === "success" ? relay : {},
            }),
          };
    for (const v of await run(
      "saved Task operation applies durable " + kind + " result",
      note("task", { outcome }),
    )) {
      successes(v);
      assert.equal(
        v.logs.at(-1).status,
        kind === "success" ? "completed" : "failed",
      );
    }
    for (const r of await rows(
      "saved Task operation round and protected result persist " + kind,
    )) {
      assert.equal(
        r.rounds[0].status,
        kind === "success" ? "completed" : "failed",
      );
      assert.equal(
        state(r, "task").status,
        kind === "success" ? "idle" : "failed",
      );
      assert.equal(r.messages.length, kind === "success" ? 2 : 1);
      if (kind === "success") {
        assert.equal(r.tasks[0].state, "complete");
        assert.equal(
          r.rounds[0].assistant_message_id,
          relay.assistantMessage.id,
        );
      }
    }
  }
  const future = "2099-01-01T00:00:00.000Z";
  registerFixedClock(Date.parse(future));
  const fence = {
    cycleId: cycle,
    operationId: operation,
    leaseOwner: "outcome-server",
    fencingToken: 7,
  };
  async function fenced({
    token = 7,
    expires = future,
    withOperation = true,
  } = {}) {
    await clean({ chat: "task" });
    const prepared = taskStart("direct", "task", 1, 1, operation),
      relay = taskResult(prepared);
    if (withOperation) {
      await observe(
        "begin fenced saved Task operation",
        { chat: "task", action: "begin", input: prepared },
        { op: "native-command-task", shape: "raw" },
      );
      await seed(
        `UPDATE task_planning_rounds SET execution_lane_id='${lane}',user_message_id='${user}' WHERE id='${operation}'`,
      );
    }
    await seed(
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,lease_owner,lease_expires_at,fencing_token,started_at,fifo_created_at,created_at,updated_at) VALUES('${cycle}',${literal(owner)},'task','${operation}','direct','running','outcome-server',${literal(expires)},${token},${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    );
    return note("task", {
      taskDispatchFence: fence,
      outcome: { ok: true, result: result({ structuredResult: relay }) },
    });
  }
  for (const [name, fields, noteFields, message] of [
    ["stale fence", { token: 8 }, {}, "Ignored a stale fenced Task outcome"],
    [
      "expired lease",
      { expires: stamp },
      {},
      "Ignored a stale fenced Task outcome",
    ],
    [
      "wrong operation",
      {},
      { taskDispatchFence: { ...fence, operationId: id(99) } },
      "Ignored a Task outcome without its claimed operation",
    ],
    [
      "missing operation",
      { withOperation: false },
      {},
      "Ignored a Task outcome without its claimed operation",
    ],
  ]) {
    const notification = { ...(await fenced(fields)), ...noteFields };
    const before = await rows("before " + name + " outcome");
    for (const v of await run("fenced outcome rejects " + name, notification)) {
      successes(v);
      assert.equal(v.logs[0].message, message);
      assert.equal(v.commands.length, 0);
    }
    assert.deepEqual(
      await rows("fenced outcome preserves rows " + name),
      before,
    );
  }
  let notification = await fenced();
  for (const v of await run(
    "valid fenced outcome renews lease before applying saved Task result",
    notification,
  )) {
    successes(v);
    assert.deepEqual(v.trace, [{ kind: "tick" }]);
  }
  for (const r of await rows(
    "fenced recovery settles durable Task, round and dispatch",
  )) {
    assert.equal(r.cycles[0].state, "succeeded");
    assert.equal(r.tasks[0].state, "complete");
    assert.equal(r.rounds[0].status, "completed");
  }
  notification = await fenced();
  await seed([
    "CREATE OR REPLACE FUNCTION outcome_settle_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.fencing_token=7 AND NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at THEN UPDATE task_dispatch_cycles SET fencing_token=8 WHERE id=NEW.id; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER outcome_settle_fence AFTER UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION outcome_settle_fence()",
  ]);
  for (const v of await run(
    "new fence after heartbeat prevents stale settlement without replaying completed result",
    notification,
  )) {
    successes(v);
    assert.deepEqual(v.trace, [{ kind: "tick" }]);
  }
  await seed([
    "DROP TRIGGER outcome_settle_fence ON task_dispatch_cycles",
    "DROP FUNCTION outcome_settle_fence()",
  ]);
  for (const r of await rows(
    "new dispatch fence remains authoritative after successful encrypted recovery",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.equal(r.cycles[0].fencing_token, 8);
    assert.equal(r.tasks[0].state, "complete");
  }
  before = await rows("Task outcome exact rows before restart");
  for (const phase of ["heartbeat", "settle"]) {
    const notification = await fenced();
    await seed([
      `CREATE OR REPLACE FUNCTION outcome_dispatch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${phase === "heartbeat" ? "NEW.state='running'" : "NEW.state IN ('succeeded','failed')"} THEN RAISE EXCEPTION 'saved outcome ${phase} SQL failure'; END IF; RETURN NEW; END $$`,
      "CREATE TRIGGER outcome_dispatch_fail BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION outcome_dispatch_fail()",
    ]);
    for (const v of await run(
      "actual " + phase + " SQL failure remains visible to outcome caller",
      notification,
    )) {
      assert.equal(v.beginError, null);
      assert.ok(v.result.snapshots[0].recoveryErrors[0]);
    }
    await seed([
      "DROP TRIGGER outcome_dispatch_fail ON task_dispatch_cycles",
      "DROP FUNCTION outcome_dispatch_fail()",
    ]);
    for (const r of await rows(
      "durable recovery boundary after " + phase + " SQL failure",
    )) {
      assert.equal(r.cycles[0].state, "running");
      assert.equal(
        r.rounds[0].status,
        phase === "heartbeat" ? "running" : "completed",
      );
      assert.equal(state(r, "task").status, "running");
      assert.equal(r.messages.length, phase === "heartbeat" ? 1 : 2);
    }
  }
  before = await rows(
    "Task outcome exact rows before restart after SQL faults",
  );
  await reopen("Task saved outcome restart");
  assert.deepEqual(await rows("Task outcome exact rows after restart"), before);
  await clean();
  for (const v of await run(
    "dropped recovery caller retains protected write through worker acknowledgement",
    note(),
    {
      holdProtection: true,
      steps: [
        recover(note(), { detached: true }),
        { kind: "wait-commands", count: 1 },
        { kind: "snapshot", sql: sqlRows },
        { kind: "release" },
        { kind: "drain" },
        { kind: "snapshot", sql: sqlRows },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(v.result.snapshots[0].messages.length, 1);
    assert.equal(state(v.result.snapshots[0]).status, "running");
    assert.equal(v.result.snapshots[1].messages.length, 2);
    assert.equal(state(v.result.snapshots[1]).status, "idle");
  }
  for (const failGoal of [false, true]) {
    await clean({ chat: "task" });
    await seed(
      "UPDATE tasks SET state='review',planning_round=1,has_plan=true,plan_goal_enabled=true WHERE chat_id='task'",
    );
    const prepared = taskStart("finalize", "task", 2, 1, operation),
      relay = taskResult(prepared);
    relay.assistantMessage.id = id(30);
    relay.assistantMessage.idempotencyKey = "recovered-final-plan";
    relay.goal.classification.threadId = "outcome-thread";
    relay.goal.startMessage.id = id(31);
    relay.goal.startMessage.idempotencyKey = `task-goal:${operation}`;
    await observe(
      "begin actual finalization operation for recovery " + failGoal,
      { chat: "task", action: "begin", input: prepared },
      { op: "native-command-task", shape: "raw" },
    );
    await seed(
      `UPDATE task_planning_rounds SET execution_lane_id='${lane}',user_message_id='${user}' WHERE id='${operation}'`,
    );
    const goalReply = {
      goal: {
        chatId: "task",
        threadId: "outcome-thread",
        status: "active",
        protectedObjective: taskEnvelope,
        tokenBudget: null,
        tokensUsed: 1,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      task: taskContent("implementing", 2, {
        hasPlan: true,
        hasFinalPlan: true,
        hasGoalPrompt: true,
      }),
      message: null,
    };
    const notification = note("task", {
      outcome: { ok: true, result: result({ structuredResult: relay }) },
    });
    for (const v of await run(
      "recovered finalization uses actual Goal launch and turn, failure=" +
        failGoal,
      notification,
      {
        goalReply,
        failCommand: failGoal ? "chat.goal.create" : undefined,
        attempts: [
          {
            templateResult: true,
            result: result({
              turnId: "recovered-goal-turn",
              structuredResult: {
                message: {
                  ...taskMessage("assistant", "goal", "<task-response-id>"),
                  idempotencyKey: "<task-response-key>",
                },
              },
            }),
          },
        ],
      },
    )) {
      successes(v);
      assert.ok(v.commands.some((c) => c.command.type === "chat.goal.create"));
      assert.equal(
        v.commands.filter((c) => c.command.type === "chat.turn").length,
        failGoal ? 0 : 1,
      );
    }
    for (const r of await rows(
      "finalization recovery retains protected plan and real Goal state " +
        failGoal,
    )) {
      assert.equal(r.tasks[0].state, failGoal ? "failed" : "implementing");
      assert.equal(r.tasks[0].has_plan, true);
      if (!failGoal) {
        assert.ok(r.tasks[0].implementation_started_at);
        assert.equal(r.messages.length, 4);
      }
    }
  }
  for (const ackFails of [false, true]) {
    await clean();
    await seed([
      "DELETE FROM chat_execution_lanes",
      "UPDATE chats SET status='idle' WHERE id='chat'",
      "UPDATE chat_runtime_sessions SET status='ready' WHERE chat_id='chat'",
    ]);
    const session = {
      ...command().session,
      threadId: "outcome-thread",
      runtimeGeneration: "outcome-runtime",
      connectionId: "outcome-connection",
      modelRouteId: "outcome-route",
    };
    const request = command({ operationId: "recovered-logical-root", session });
    const admitted = await observe(
      "admit actual logical GUI root for saved recovery " + ackFails,
      request,
      { options: { clientMessageId: user } },
    );
    for (const v of admitted) assert.equal(v.receipt.status, "accepted");
    await seed(
      (i) =>
        `UPDATE chat_messages SET execution_lane_id=${literal(admitted[i].receipt.executionLaneId)} WHERE id='${user}'`,
    );
    await observe(
      "dispatch actual logical root before interrupted outcome " + ackFails,
      (i) => ({
        workerId: "alpha",
        operationId: request.operationId,
        operationGeneration: admitted[i].receipt.operationGeneration,
        payloadDigest: request.payloadDigest,
        session,
      }),
      { op: "native-command-dispatch", status: "dispatched" },
    );
    await observe(
      "settle native application while retaining logical GUI ownership " +
        ackFails,
      (i) => ({
        workerId: "alpha",
        operationId: request.operationId,
        operationGeneration: admitted[i].receipt.operationGeneration,
        status: "applied",
        resultDigest: "a".repeat(64),
        protectedResult: request.protectedPayload,
        rejectionCode: null,
        executionComplete: false,
      }),
      { op: "native-command-settle", shape: "receipt", status: "applied" },
    );
    const notification = (i) =>
      note("chat", {
        executionLaneId: admitted[i].receipt.executionLaneId,
        nativeLogicalRoot: {
          operationId: request.operationId,
          operationGeneration: admitted[i].receipt.operationGeneration,
        },
      });
    for (const v of await observe(
      "recover actual GUI logical closure, lost ACK=" + ackFails,
      (i) => ({
        chat: "chat",
        protectedMessage,
        failCommand: ackFails ? "chat.native-logical.complete" : undefined,
        steps: [recover(notification(i)), { kind: "drain" }],
      }),
      { op: "native-command-turn-outcome", shape: "raw" },
    )) {
      successes(v);
      assert.equal(
        v.commands.filter(
          (c) => c.command.type === "chat.native-logical.complete",
        ).length,
        1,
      );
      assert.equal(
        v.logs.some(
          (l) =>
            l.message ===
            "Recovered logical completion remains queued for acknowledgment",
        ),
        ackFails,
      );
    }
    for (const r of await rows(
      "logical completion acknowledgement durable outbox " + ackFails,
    ))
      assert.equal(r.logical?.length ?? 0, ackFails ? 1 : 0);
    const next = await observe(
      "newer GUI root can start after recovered closure " + ackFails,
      command({ operationId: "recovered-logical-next", session }),
      { options: { clientMessageId: id(21) } },
    );
    for (const v of next) assert.equal(v.receipt.status, "accepted");
    for (const v of await observe(
      "older recovered logical outcome cannot finish newer root " + ackFails,
      (i) => ({
        chat: "chat",
        protectedMessage,
        steps: [recover(notification(i)), { kind: "drain" }],
      }),
      { op: "native-command-turn-outcome", shape: "raw" },
    )) {
      successes(v);
      assert.equal(v.commands.length, 0);
      assert.equal(
        v.logs[0].message,
        "Ignored an agent turn outcome outside its execution lane",
      );
    }
    const current = await observe(
      "newer activation survives old recovered outcome " + ackFails,
      {
        sql: "SELECT jsonb_build_object('operation',(SELECT operation_id FROM native_command_activations WHERE chat_id='chat'),'active',(SELECT active FROM native_command_activations WHERE chat_id='chat')) result",
      },
      { op: "query-json", shape: "raw" },
    );
    for (const r of current) {
      assert.equal(r.operation, "recovered-logical-next");
      assert.equal(r.active, true);
    }
  }
}
