import assert from "node:assert/strict";
import {
  literal,
  json,
  stamp,
  otherOwner,
  label,
} from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
export async function runAutomationPauseCases(h) {
  const { observe, seed, reset, owner, reopen } = h;
  let sequence = 0;
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('pause-provider',${literal(owner)},'Pause','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('pause-model',${literal(owner)},'Pause') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('pause-route','pause-model','pause-provider','pause',0) ON CONFLICT DO NOTHING",
  ]);
  async function clean({
    chat = "task",
    bound = false,
    paused = false,
    extra = [],
  } = {}) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM chat_messages",
      `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES('task',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
      "UPDATE chats SET archived_at=NULL,status='idle',automation_paused=false,managed_autonomy_stopped=false,model_id='pause-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id IN ('chat','task')",
      "UPDATE chats SET experience='agent' WHERE id='chat'",
      "UPDATE chats SET experience='task' WHERE id='task'",
      "UPDATE user_settings SET default_model_id='pause-model',auto_name_tasks=false,auto_name_chats=false",
      `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      `UPDATE chats SET automation_paused=${paused} WHERE id=${literal(chat)}`,
      ...(bound
        ? [
            `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('82828282-8282-4828-8828-000000000001',${literal(chat)},'alpha','github-alpha-main','pause-thread','pause-route','ready')`,
          ]
        : []),
      ...extra,
    ]);
  }
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        chat: "task",
        action: "pause",
        paused: true,
        resumeAutomation: false,
        pausePrefix: "pause-" + sequence++,
        pauseProtectedPayload: command().protectedPayload,
        ...fields,
      },
      { op: "native-command-automation-pause", shape: "raw" },
    );
  const rows = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(jsonb_build_object('id',id,'paused',automation_paused,'autonomyStopped',managed_autonomy_stopped,'status',status,'archivedAt',archived_at,'updatedAt',updated_at) ORDER BY id) FROM chats WHERE id IN ('chat','task')),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  const state = (r, chat = "task") => r.chats.find((c) => c.id === chat);
  async function bad(name, fields, code, message) {
    const values = await run(name, fields);
    for (const v of values) {
      assert.ok(v.error, name);
      assert.equal(v.error.statusCode, code);
      if (message) assert.equal(v.error.message, message);
    }
    return values;
  }
  await clean();
  for (const v of await run(
    "legacy Task pause waits for worker boundary acknowledgement",
    {
      pauseReplies: [
        {
          paused: true,
          active: { threadId: "turn-thread", turnId: "turn-id" },
        },
      ],
    },
  )) {
    assert.deepEqual(v.result, {
      paused: true,
      active: { threadId: "turn-thread", turnId: "turn-id" },
    });
    assert.equal(v.commands[0].timeoutMs, null);
    assert.equal(v.commands[0].command.type, "chat.pause.set");
    assert.deepEqual(v.trace, [
      { kind: "pause-boundary", chat: "task", paused: false },
    ]);
    assert.equal(v.events.length, 1);
  }
  let before = await rows("acknowledged pause and queue revision persisted");
  for (const r of before) assert.equal(state(r).paused, true);
  await reopen("worker-acknowledged Task pause reopen");
  assert.deepEqual(
    await rows("acknowledged pause exact rows after reopen"),
    before,
  );
  for (const v of await run(
    "legacy Task unpause remains durable-paused until acknowledgement",
    { paused: false },
  )) {
    assert.equal(v.result.paused, false);
    assert.deepEqual(v.trace, [
      { kind: "pause-boundary", chat: "task", paused: true },
    ]);
  }
  await clean({
    chat: "chat",
    paused: true,
    extra: ["UPDATE chats SET managed_autonomy_stopped=true WHERE id='chat'"],
  });
  for (const v of await run(
    "managed unpause commits before a legacy worker command",
    { chat: "chat", paused: false },
  )) {
    assert.equal(v.result.paused, false);
    assert.deepEqual(v.trace, [
      { kind: "pause-boundary", chat: "chat", paused: false },
    ]);
  }
  for (const r of await rows(
    "managed unpause also clears actual autonomy stop",
  ))
    assert.equal(state(r, "chat").autonomyStopped, false);
  await clean();
  await bad(
    "legacy opposite acknowledgement cannot claim a pause",
    { pauseReplies: [{ paused: false, active: null }] },
    502,
    "The worker could not pause this chat at a safe boundary: The worker did not acknowledge the requested pause state.",
  );
  for (const r of await rows(
    "opposite acknowledgement leaves old durable intent",
  ))
    assert.equal(state(r).paused, false);
  for (const reply of [
    null,
    {},
    { paused: true },
    { paused: true, active: null, unknown: true },
    { paused: true, active: { threadId: "t", turnId: "u", unknown: true } },
  ]) {
    await clean();
    await bad(
      "invalid pause receipt retains exact Source validation error " +
        JSON.stringify(reply),
      { pauseReplies: [reply] },
      502,
    );
  }
  await clean({ chat: "chat" });
  for (const v of await run(
    "managed fallback keeps Source acknowledgement semantics",
    { chat: "chat", pauseReplies: [{ paused: false, active: null }] },
  ))
    assert.equal(v.result.paused, true);
  await clean({ chat: "chat", paused: true });
  for (const v of await bad(
    "managed failed unpause re-pauses durable state",
    { chat: "chat", paused: false, pauseErrors: ["Worker refused resume"] },
    502,
    "The worker could not resume this chat: Worker refused resume",
  ))
    assert.equal(v.events.length, 1);
  for (const r of await rows("managed failed unpause rollback persisted"))
    assert.equal(state(r, "chat").paused, true);
  await clean({ paused: true });
  for (const v of await bad(
    "legacy failed unpause leaves its old pause intact",
    { paused: false, pauseErrors: ["Worker refused resume"] },
    502,
  ))
    assert.equal(v.events.length, 0);
  for (const paused of [true, false]) {
    await clean({ chat: "chat", paused: !paused });
    const message = "Worker boundary \ud800\udfff e\u0301 🌒";
    await bad(
      "worker pause error retains exact UTF16 units " + paused,
      { chat: "chat", paused, pauseErrors: [message] },
      502,
      (paused
        ? "The worker could not pause this chat at a safe boundary: "
        : "The worker could not resume this chat: ") + message,
    );
  }
  await clean({
    chat: "chat",
    bound: true,
    paused: true,
  });
  for (const v of await bad(
    "actual Goal resume failure rolls back and compensates worker",
    {
      chat: "chat",
      paused: false,
      resumeAutomation: true,
      goalReply: { resumed: "invalid" },
    },
    409,
    "This chat remains paused because its next action could not start: The native automation resume receipt is invalid.",
  )) {
    assert.equal(v.events.length, 2);
    assert.deepEqual(
      v.commands.map((c) => c.command.type),
      ["chat.pause.set", "chat.automation.resume", "chat.pause.set"],
    );
    assert.equal(v.commands[0].timeoutMs, null);
    assert.equal(v.commands[1].timeoutMs, 600000);
    assert.equal(v.commands[2].timeoutMs, 600000);
    assert.equal(v.commands[2].command.paused, true);
  }
  for (const r of await rows("failed next action preserves durable pause"))
    assert.equal(state(r, "chat").paused, true);
  await clean({ bound: true, paused: true });
  await bad(
    "offline retained thread cannot lose paused work",
    { paused: false, connected: false },
    503,
  );
  await clean({
    paused: true,
    extra: [
      `INSERT INTO queued_prompts(id,chat_id,text,mode,model_id,idempotency_key,position,created_at,updated_at) VALUES('pause-prompt','task','legacy queued input','default','pause-model','pause-queued',0,${literal(stamp)},${literal(stamp)})`,
    ],
  });
  await bad(
    "offline queued prompt prevents unpause",
    { paused: false, connected: false },
    503,
  );
  await clean({ chat: "chat", paused: true });
  for (const v of await run(
    "offline empty managed chat may clear pause without losing an action",
    { chat: "chat", paused: false, connected: false, resumeAutomation: true },
  )) {
    assert.equal(v.result.paused, false);
    assert.equal(v.commands.length, 0);
  }
  await clean({ bound: true });
  for (const v of await run("offline Task can persist pause", {
    connected: false,
  })) {
    assert.equal(v.result.paused, true);
    assert.equal(v.commands.length, 0);
  }
  await clean();
  await bad(
    "foreign pause cannot reach worker",
    { owner: otherOwner },
    404,
    "Chat source not found.",
  );
  await bad(
    "missing pause cannot reach worker",
    { chat: "missing" },
    404,
    "Chat source not found.",
  );
  await clean();
  await bad(
    "deleted source after boundary triggers compensating worker command",
    { pauseBeforeReplySQL: ["DELETE FROM chats WHERE id='task'"] },
    404,
    "Chat source not found.",
  );
  await clean();
  for (const v of await run("admitted pause survives a dropped caller waiter", {
    detached: true,
  }))
    assert.equal(v.result, null);
  for (const r of await rows(
    "dropped waiter pause reaches its durable boundary",
  ))
    assert.equal(state(r).paused, true);
  await clean({ chat: "chat", bound: true, paused: true });
  for (const v of await run(
    "actual managed Goal resume follows worker acknowledgement",
    {
      chat: "chat",
      paused: false,
      resumeAutomation: true,
      goalReply: { resumed: false },
    },
  )) {
    assert.equal(v.result.paused, false);
    assert.ok(
      v.commands.some((c) => c.command.type === "chat.automation.resume"),
    );
    assert.ok(v.trace.some((t) => t.kind === "queue"));
  }
  async function active() {
    await clean({ chat: "chat", bound: true });
    const input = command({
      operationId: "pause-root",
      session: {
        chatId: "chat",
        threadId: "pause-thread",
        modelRouteId: "pause-route",
        runtimeGeneration: "pause-runtime",
        connectionId: "pause-connection",
      },
    });
    const admitted = await observe("admit actual managed pause root", input);
    await observe(
      "dispatch actual managed pause root",
      (i) => ({
        workerId: "alpha",
        operationId: input.operationId,
        operationGeneration: admitted[i].receipt.operationGeneration,
        payloadDigest: input.payloadDigest,
        session: input.session,
      }),
      { op: "native-command-dispatch", status: "dispatched" },
    );
  }
  for (const paused of [true, false]) {
    await active();
    await seed(`UPDATE chats SET automation_paused=${!paused} WHERE id='chat'`);
    for (const v of await run(
      "actual native control persists authorized intent " + paused,
      { chat: "chat", paused },
    )) {
      assert.equal(v.result.paused, paused);
      assert.equal(v.commands[0].command.type, "chat.native-control");
      assert.ok(v.trace.some((t) => t.kind === "native-pause-dispatched"));
    }
    await h.snapshot(
      "actual native pause receipt and intent durable " + paused,
    );
    for (const r of await rows("native pause authoritative state " + paused))
      assert.equal(state(r, "chat").paused, paused);
  }
  for (const paused of [true, false]) {
    await active();
    await seed(`UPDATE chats SET automation_paused=${!paused} WHERE id='chat'`);
    for (const v of await run(
      "older native pause acknowledgement preserves newer intent " + paused,
      {
        chat: "chat",
        paused,
        overlap: true,
        holdPauseFirst: true,
        resumeAutomation: true,
      },
    )) {
      assert.equal(v.result.older.paused, !paused);
      assert.equal(v.result.newer.paused, !paused);
      assert.equal(v.commands.length, 2);
      assert.equal(
        v.trace.filter((t) => t.kind === "native-pause-dispatched").length,
        2,
      );
    }
    await h.snapshot("overlapped native controls keep real receipts " + paused);
    for (const r of await rows(
      "newer native intent is authoritative " + paused,
    ))
      assert.equal(state(r, "chat").paused, !paused);
  }
  await active();
  for (const v of await run(
    "active native receipt uses dispatched intent instead of echoed pause value",
    {
      chat: "chat",
      paused: true,
      pauseReplies: [{ paused: false, active: null }],
    },
  ))
    assert.equal(v.result.paused, true);
  await h.snapshot("native opposite echo keeps authorized durable intent");
  for (const paused of [true, false]) {
    await active();
    await seed(`UPDATE chats SET automation_paused=${!paused} WHERE id='chat'`);
    for (const v of await bad(
      "failed native boundary retains authorized dispatch and safe pause " +
        paused,
      {
        chat: "chat",
        paused,
        pauseErrorsAfterDispatch: ["Native boundary failed"],
      },
      502,
    ))
      assert.equal(v.events.length, paused ? 0 : 1);
    await h.snapshot("failed native boundary real receipt " + paused);
    for (const r of await rows(
      "failed native boundary actual durable pause " + paused,
    ))
      assert.equal(state(r, "chat").paused, true);
  }
  before = await rows("native control state before restart");
  await reopen("native pause intent reopen");
  assert.deepEqual(
    await rows("native control exact state after restart"),
    before,
  );
}
