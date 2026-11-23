import assert from "node:assert/strict";
import {
  literal,
  json,
  label,
  stamp,
  otherOwner,
} from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";

// Real list/context/pause/Goal/dispatch/Live services. Worker acknowledgements
// are controlled; authenticated public routes and actual worker acceptance remain.
export async function runProjectTaskPauseCases(h) {
  const { observe, seed, reset, owner, reopen, registerFixedClock } = h;
  const future = "2099-01-01T00:00:00.000Z";
  registerFixedClock(Date.parse(future));
  const id = (n) => `84848484-8484-4848-8848-${String(n).padStart(12, "0")}`;
  const chat = (name) => "project-pause-" + name;
  const query =
    "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c WHERE id LIKE 'project-pause-%'),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'cycles',(SELECT jsonb_agg(to_jsonb(d) ORDER BY chat_id) FROM task_dispatch_cycles d),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q WHERE chat_id LIKE 'project-pause-%')) result";
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('project-pause-provider',${literal(owner)},'Project pause','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('project-pause-model',${literal(owner)},'Project pause') ON CONFLICT DO NOTHING`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('project-pause-route','project-pause-model','project-pause-provider','pause',0,true) ON CONFLICT DO NOTHING",
  ]);
  async function clean(specs) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "DELETE FROM chat_messages",
      "DELETE FROM chats WHERE id LIKE 'project-pause-%'",
      "DELETE FROM task_workers",
      "UPDATE user_settings SET auto_name_tasks=false,auto_name_chats=false",
      `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,max_concurrency,created_at,updated_at) VALUES('${id(1)}',${literal(owner)},'Project pause','project-pause-model','project-pause-family',2,${literal(stamp)},${literal(stamp)})`,
    ]);
    for (const [i, s] of specs.entries()) {
      const c = chat(s.name),
        foreign = s.project === "other",
        who = foreign ? otherOwner : owner;
      const project = s.project ?? "github",
        worker = foreign ? "foreign" : "alpha",
        tree = project + "-" + worker + "-main";
      await seed([
        `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,status,automation_paused,model_id,protected_label,created_at,updated_at,last_used_at,archived_at) VALUES(${literal(c)},${literal(who)},${literal(project)},${literal(worker)},${literal(tree)},${literal(s.experience ?? "task")},${literal(s.status ?? "idle")},${s.paused === true},'project-pause-model',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(s.archived ? stamp : null)})`,
        `INSERT INTO tasks(chat_id,state,protected_content,created_at,updated_at) VALUES(${literal(c)},${literal(s.state ?? "draft")},${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
        ...(s.bound
          ? [
              `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status) VALUES('${id(100 + i)}',${literal(c)},${literal(worker)},${literal(tree)},${literal("context-" + s.name)},'project-pause-route','ready')`,
            ]
          : []),
        ...(s.cycle
          ? [
              `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,selected_task_worker_id,physical_worker_id,worktree_id,model_configuration,lease_owner,lease_expires_at,fencing_token,codex_thread_id,turn_id,started_at,fifo_created_at,created_at,updated_at) VALUES('${id(10 + i)}',${literal(who)},${literal(c)},'${id(50 + i)}','direct',${literal(s.cycle)},'${id(1)}',${literal(worker)},${literal(tree)},${json({ modelId: "project-pause-model", reasoningEffort: null, customSubagentModel: false, subagentModelId: null, subagentReasoningEffort: null })},'project-pause-server',${literal(s.expires ?? future)},7,${literal(s.thread ?? null)},${literal(s.turn ?? null)},${literal(s.started ? stamp : null)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
            ]
          : []),
      ]);
      if (s.cycle)
        await seed(
          `UPDATE task_dispatch_cycles SET model_route_id='project-pause-route',task_worker_revision=1 WHERE id=${literal(id(10 + i))}`,
        );
    }
  }
  const pause = (paused = true, fields = {}) => ({
    kind: "project-pause",
    paused,
    ...fields,
  });
  const run = (name, fields = {}) =>
    observe(
      name,
      { chat: chat("a"), steps: [pause()], ...fields },
      { op: "native-command-task-background", shape: "raw" },
    );
  const rows = (name) =>
    observe(name, { sql: query }, { op: "query-json", shape: "raw" });
  const commands = (v) =>
    v.commands.filter((c) =>
      ["chat.pause.set", "chat.native-control"].includes(c.command.type),
    );
  const success = (v) => {
    assert.equal(v.beginError, null);
    assert.equal(v.result.snapshots[0].projectPauseError, null);
  };
  const state = (r, name) => r.chats.find((c) => c.id === chat(name));

  await clean([
    { name: "running", status: "running" },
    { name: "approval", status: "waiting-for-approval" },
    { name: "goal", state: "implementing" },
    { name: "manual", state: "paused", paused: true },
    { name: "complete", state: "complete", status: "running" },
    { name: "failed", state: "failed", status: "running" },
    { name: "draft" },
    { name: "queued", cycle: "queued" },
    { name: "agent", experience: "agent", status: "running" },
    { name: "archived", archived: true, status: "running" },
    { name: "foreign", project: "other", status: "running" },
  ]);
  for (const v of await run(
    "project controls pause active execution, between-turn Goals and manual pauses only",
  )) {
    success(v);
    assert.deepEqual(
      commands(v)
        .map((c) => c.command.chatId)
        .sort(),
      ["approval", "goal", "manual", "running"].map(chat),
    );
    assert.ok(commands(v).every((c) => c.timeoutMs === null));
  }
  let before = await rows(
    "project pause mixed states, protected envelopes and excluded tenants persist",
  );
  for (const r of before) {
    for (const name of ["approval", "goal", "manual", "running"])
      assert.equal(state(r, name).automation_paused, true);
    for (const name of [
      "complete",
      "failed",
      "draft",
      "queued",
      "agent",
      "archived",
      "foreign",
    ])
      assert.equal(state(r, name).automation_paused, false);
    for (const task of r.tasks)
      assert.deepEqual(task.protected_content, taskEnvelope);
  }
  await reopen("project pause mixed-state restart");
  assert.deepEqual(
    await rows("project pause exact mixed-state rows after restart"),
    before,
  );

  await clean([
    { name: "a", state: "planning", cycle: "claimed", bound: true },
  ]);
  for (const v of await run(
    "unstarted claim pauses durably without contacting worker",
  )) {
    success(v);
    assert.equal(commands(v).length, 0);
  }
  for (const r of await rows(
    "unstarted pause increments fence and uses actual context affinity",
  )) {
    assert.equal(r.cycles[0].state, "paused");
    assert.equal(r.cycles[0].fencing_token, 8);
    assert.equal(r.cycles[0].codex_thread_id, "context-a");
    assert.equal(state(r, "a").automation_paused, true);
  }
  for (const v of await run(
    "project resume cannot bypass paused dispatch capacity or lease acquisition",
    { steps: [pause(false)] },
  )) {
    success(v);
    assert.equal(commands(v).length, 0);
  }
  for (const r of await rows(
    "project resume leaves fenced paused dispatch for scheduler",
  ))
    assert.equal(r.cycles[0].state, "paused");
  await seed(
    `UPDATE workers SET encryption_status=${json({ supported: true, state: "ready", principalId: id(3), grants: [{ component: "task-content", keyRevision: 1 }], lastSyncedAt: stamp, error: null })} WHERE id='alpha'`,
  );
  for (const v of await run(
    "project resume yields to actual scheduler capacity and lease admission",
    {
      pauseReplies: [
        {
          paused: false,
          active: { threadId: "context-a", turnId: "resumed-turn" },
        },
      ],
      steps: [
        pause(false),
        { kind: "tick" },
        { kind: "wait" },
        { kind: "drain" },
      ],
    },
  )) {
    success(v);
    assert.deepEqual(
      commands(v).map((c) => c.command.paused),
      [false],
    );
  }
  for (const r of await rows(
    "scheduler reacquires paused claim before acknowledged worker unpause",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.equal(r.cycles[0].attempt_count, 1);
    assert.equal(state(r, "a").automation_paused, false);
  }

  await clean([
    {
      name: "a",
      status: "running",
      cycle: "running",
      started: true,
      thread: "retained-thread",
      turn: "retained-turn",
    },
  ]);
  for (const v of await run(
    "active dispatch uses acknowledged worker affinity",
    {
      pauseReplies: [
        {
          paused: true,
          active: { threadId: "ack-thread", turnId: "ack-turn" },
        },
      ],
    },
  )) {
    success(v);
    assert.equal(commands(v).length, 1);
  }
  for (const r of await rows(
    "acknowledged affinity and existing fence persist",
  )) {
    assert.equal(r.cycles[0].state, "paused");
    assert.equal(r.cycles[0].fencing_token, 7);
    assert.equal(r.cycles[0].codex_thread_id, "ack-thread");
    assert.equal(r.cycles[0].turn_id, "ack-turn");
  }

  for (const started of [false, true]) {
    await clean([
      {
        name: "a",
        status: started ? "running" : "idle",
        state: "planning",
        cycle: started ? "running" : "claimed",
        started,
        thread: "saved-thread",
        turn: "saved-turn",
        bound: true,
      },
    ]);
    for (const v of await run(
      "null acknowledgement retains saved dispatch affinity, started=" +
        started,
    )) {
      success(v);
      assert.equal(commands(v).length, started ? 1 : 0);
    }
    for (const r of await rows(
      "retained affinity remains exact, started=" + started,
    )) {
      assert.equal(r.cycles[0].codex_thread_id, "saved-thread");
      assert.equal(r.cycles[0].turn_id, "saved-turn");
    }
  }

  await clean([
    { name: "a", status: "running", cycle: "running", started: true },
    { name: "b", status: "running" },
  ]);
  for (const v of await run(
    "stale dispatch fence is swallowed only after actual worker pause",
    {
      pauseByChat: {
        [chat("a")]: {
          pauseBeforeReplySQL:
            "UPDATE task_dispatch_cycles SET fencing_token=fencing_token+1",
        },
      },
    },
  )) {
    success(v);
    assert.equal(commands(v).length, 2);
  }
  for (const r of await rows(
    "stale cycle keeps new fence while acknowledged automation remains paused",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.equal(r.cycles[0].fencing_token, 8);
    assert.equal(state(r, "a").automation_paused, true);
    assert.equal(state(r, "b").automation_paused, true);
  }

  await clean([
    { name: "a", status: "running" },
    { name: "b", status: "running" },
  ]);
  for (const v of await run(
    "dropped caller retains concurrent project pause through worker acknowledgement",
    {
      holdPauseChats: [chat("a")],
      steps: [
        pause(true, { detached: true }),
        { kind: "wait-commands", command: "chat.pause.set", count: 2 },
        {
          kind: "wait-sql",
          sql: `SELECT automation_paused result FROM chats WHERE id=${literal(chat("b"))}`,
          value: true,
        },
        { kind: "snapshot", sql: query },
        { kind: "release" },
        { kind: "drain" },
        { kind: "snapshot", sql: query },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(state(v.result.snapshots[0], "a").automation_paused, false);
    assert.equal(state(v.result.snapshots[0], "b").automation_paused, true);
    assert.equal(state(v.result.snapshots[1], "a").automation_paused, true);
  }

  for (const paused of [true, false]) {
    await clean([
      { name: "a", status: "running", paused: !paused },
      { name: "b", status: "running", paused: !paused },
      { name: "c", status: "running", paused: !paused },
    ]);
    const prefix = paused
      ? "The worker could not pause this chat at a safe boundary: "
      : "The worker could not resume this chat: ";
    const errors = {
      [chat("a")]: { pauseErrors: "first \ud800" },
      [chat("c")]: { pauseErrors: "last \udfff" },
    };
    for (const v of await run(
      "all Tasks settle and aggregate UTF16 failures in list order, paused=" +
        paused,
      { pauseByChat: errors, steps: [pause(paused)] },
    )) {
      assert.equal(v.beginError, null);
      assert.equal(commands(v).length, 3);
      assert.equal(
        v.result.snapshots[0].projectPauseError,
        `2 Tasks could not ${paused ? "pause" : "resume"}: ${prefix}last \udfff; ${prefix}first \ud800`,
      );
    }
    for (const r of await rows(
      "healthy Task survives sibling failures, paused=" + paused,
    )) {
      assert.equal(state(r, "b").automation_paused, paused);
      assert.equal(state(r, "a").automation_paused, !paused);
      assert.equal(state(r, "c").automation_paused, !paused);
    }
  }

  await clean([
    { name: "a", status: "running" },
    { name: "b", status: "running" },
  ]);
  for (const v of await run(
    "opposite worker acknowledgement reports one failure and still pauses sibling",
    {
      pauseByChat: {
        [chat("a")]: { pauseReplies: { paused: false, active: null } },
      },
    },
  )) {
    assert.equal(
      v.result.snapshots[0].projectPauseError,
      "1 Task could not pause: The worker could not pause this chat at a safe boundary: The worker did not acknowledge the requested pause state.",
    );
  }
  for (const r of await rows(
    "opposite acknowledgement preserves failed Task old intent",
  )) {
    assert.equal(state(r, "a").automation_paused, false);
    assert.equal(state(r, "b").automation_paused, true);
  }

  await clean([
    { name: "a", state: "planning", cycle: "claimed" },
    { name: "b", status: "running" },
  ]);
  await seed([
    `CREATE OR REPLACE FUNCTION project_pause_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(chat("a"))} AND NEW.automation_paused AND NOT OLD.automation_paused THEN RAISE EXCEPTION 'project pause SQL failure'; END IF; RETURN NEW; END $$`,
    "CREATE TRIGGER project_pause_test_fail BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION project_pause_test_fail()",
  ]);
  for (const v of await run(
    "actual unstarted pause SQL failure settles siblings and remains visible",
  )) {
    assert.equal(v.beginError, null);
    assert.match(
      v.result.snapshots[0].projectPauseError,
      /^1 Task could not pause: Failed query: update "chats" .*\nparams: true,/s,
    );
    assert.deepEqual(
      commands(v).map((c) => c.command.chatId),
      [chat("b")],
    );
  }
  await seed([
    "DROP TRIGGER project_pause_test_fail ON chats",
    "DROP FUNCTION project_pause_test_fail()",
  ]);
  for (const r of await rows(
    "failed unstarted SQL preserves claim and healthy sibling acknowledgement",
  )) {
    assert.equal(r.cycles[0].state, "claimed");
    assert.equal(r.cycles[0].fencing_token, 7);
    assert.equal(state(r, "a").automation_paused, false);
    assert.equal(state(r, "b").automation_paused, true);
  }

  for (const started of [false, true]) {
    await clean([
      {
        name: "a",
        status: started ? "running" : "idle",
        state: "planning",
        cycle: started ? "running" : "claimed",
        started,
      },
      { name: "b", status: "running" },
    ]);
    await seed([
      "CREATE OR REPLACE FUNCTION project_pause_dispatch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='paused' THEN RAISE EXCEPTION 'project dispatch pause SQL failure'; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER project_pause_dispatch_fail BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION project_pause_dispatch_fail()",
    ]);
    for (const v of await run(
      "dispatch SQL failure is not swallowed as a lease conflict, started=" +
        started,
    )) {
      assert.equal(v.beginError, null);
      assert.match(
        v.result.snapshots[0].projectPauseError,
        /^1 Task could not pause: Failed query: update "task_dispatch_cycles" .*\nparams: paused,/s,
      );
      assert.equal(commands(v).length, started ? 2 : 1);
    }
    await seed([
      "DROP TRIGGER project_pause_dispatch_fail ON task_dispatch_cycles",
      "DROP FUNCTION project_pause_dispatch_fail()",
    ]);
    for (const r of await rows(
      "dispatch SQL failure retains actual automation intent and original cycle, started=" +
        started,
    )) {
      assert.equal(r.cycles[0].state, started ? "running" : "claimed");
      assert.equal(state(r, "a").automation_paused, true);
      assert.equal(state(r, "b").automation_paused, true);
    }
  }

  await clean([
    { name: "a", state: "planning", cycle: "claimed" },
    { name: "b", status: "running" },
  ]);
  await seed([
    `INSERT INTO managed_queue_states(chat_id,revision) VALUES(${literal(chat("a"))},11),(${literal(chat("b"))},11)`,
    `CREATE OR REPLACE FUNCTION project_pause_queue_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_id=${literal(chat("a"))} THEN RAISE EXCEPTION 'project pause queue revision failure'; END IF; RETURN NEW; END $$`,
    "CREATE TRIGGER project_pause_queue_fail BEFORE UPDATE ON managed_queue_states FOR EACH ROW EXECUTE FUNCTION project_pause_queue_fail()",
  ]);
  for (const v of await run(
    "queue revision SQL failure rolls back unstarted Chat pause transaction",
  )) {
    assert.equal(v.beginError, null);
    assert.match(
      v.result.snapshots[0].projectPauseError,
      /^1 Task could not pause: Failed query: update "managed_queue_states" .*\nparams: project-pause-a/s,
    );
  }
  await seed([
    "DROP TRIGGER project_pause_queue_fail ON managed_queue_states",
    "DROP FUNCTION project_pause_queue_fail()",
  ]);
  for (const r of await rows(
    "queue write rollback preserves old intent and independent healthy revision",
  )) {
    assert.equal(state(r, "a").automation_paused, false);
    assert.equal(state(r, "b").automation_paused, true);
    assert.deepEqual(
      r.queues.map((q) => [q.chat_id, q.revision]),
      [
        [chat("a"), 11],
        [chat("b"), 12],
      ],
    );
    assert.equal(r.cycles[0].state, "claimed");
  }

  await clean([
    { name: "a", paused: true, cycle: "paused", status: "running" },
    { name: "b", paused: true, status: "running" },
    { name: "c", status: "running" },
  ]);
  for (const v of await run(
    "project resume controls only unscheduled durably-paused Tasks",
    { steps: [pause(false)] },
  )) {
    success(v);
    assert.deepEqual(
      commands(v).map((c) => c.command.chatId),
      [chat("b")],
    );
  }
  for (const r of await rows(
    "scheduler-owned paused Task remains paused after list resume",
  )) {
    assert.equal(state(r, "a").automation_paused, true);
    assert.equal(state(r, "b").automation_paused, false);
  }

  await clean([{ name: "a", paused: true, bound: true }]);
  for (const v of await run(
    "offline resume cannot lose retained worker action",
    { connected: false, steps: [pause(false)] },
  )) {
    assert.equal(commands(v).length, 0);
    assert.equal(
      v.result.snapshots[0].projectPauseError,
      "1 Task could not resume: The project worker is offline. This chat remains paused so its next action is not lost.",
    );
  }

  await clean([{ name: "foreign", project: "other", status: "running" }]);
  for (const v of await run("wrong owner cannot control foreign project", {
    steps: [pause(true, { project: "other" })],
  })) {
    success(v);
    assert.equal(commands(v).length, 0);
  }
  for (const v of await run(
    "correct owner pause preserves actual tenant worker and Live ownership",
    { steps: [pause(true, { project: "other", owner: otherOwner })] },
  )) {
    success(v);
    assert.deepEqual(
      commands(v).map((c) => c.worker),
      ["foreign"],
    );
    assert.ok(v.events.length > 0);
    assert.ok(v.events.every((e) => e.ownerId === otherOwner));
  }
  before = await rows("project control final owner rows before restart");
  await reopen("project control tenant state restart");
  assert.deepEqual(
    await rows("project control final exact rows after restart"),
    before,
  );
}
