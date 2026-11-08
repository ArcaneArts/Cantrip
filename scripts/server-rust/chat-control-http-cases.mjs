import assert from "node:assert/strict";
import {
  chat,
  primary,
  tree,
  lane,
  peer,
  standalone,
  scratch,
  offlineChat,
  offlineWorker,
  folderChat,
  model,
  q,
  reset,
  seedLane,
  placed,
} from "./chat-control-state.mjs";

export async function chatControlCases({ h, f, settle }) {
  const base = (id = chat) => "/api/chats/" + id;
  const worktree = base() + "/worktree",
    lanes = base() + "/execution-lanes",
    compact = base() + "/compact";
  const release = (c = chat, n = 1) =>
    base(c) + "/execution-lanes/" + lane(n) + "/release";
  const input = { worktreeId: tree(1), mode: "pinned" };
  const noCommands = ({ commands }) => assert.deepEqual(commands, []);
  const error =
    (text, expectedTypes = []) =>
    ({ body, commands }) => {
      assert.equal(body.error, text);
      assert.deepEqual(
        commands.map((c) => c.type),
        expectedTypes,
      );
    };
  const current = (snapshot) => snapshot.chats.find((c) => c.id === chat);
  const selected = (snapshot) =>
    snapshot.chat_execution_lanes.find((l) => l.id === lane(1));
  const test = (name, method, path, options = {}, check) =>
    settle(
      name,
      method,
      path,
      { ...options, setup: [...reset(), ...(options.setup ?? [])] },
      check,
    );

  await test("empty lanes", "GET", lanes, {}, ({ body, commands }) => {
    assert.deepEqual(body, []);
    assert.deepEqual(commands, []);
  });
  await test(
    "missing Chat lanes",
    "GET",
    base("missing") + "/execution-lanes",
    {},
    ({ body }) => assert.deepEqual(body, []),
  );
  await test(
    "all lane states in descending creation order",
    "GET",
    lanes,
    {
      setup: [
        seedLane({ n: 1, state: "suspended", exclusive: false }),
        seedLane({ n: 2, state: "released", exclusive: false }),
        seedLane({ n: 3, state: "active", exclusive: false }),
      ],
    },
    ({ body, commands }) => {
      assert.deepEqual(
        body.map((l) => l.id),
        [lane(3), lane(2), lane(1)],
      );
      assert.deepEqual(
        body.map((l) => l.state),
        ["active", "released", "suspended"],
      );
      assert.deepEqual(commands, []);
    },
  );
  await test(
    "HEAD lanes",
    "HEAD",
    lanes,
    { compareContentLength: true },
    ({ body }) => assert.equal(body, null),
  );
  await test(
    "standalone lanes rejected by shared IDE guard",
    "GET",
    base(standalone) + "/execution-lanes",
    {
      setup: [
        `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,state) VALUES('control-scratch-lane',${q(standalone)},${q(scratch)},${q(h.scope.workerId)},'user','suspended')`,
      ],
      status: 409,
    },
    error("This IDE-only Chat feature is unavailable in standalone Chat."),
  );
  if (f.name === "accounts") {
    await test(
      "foreign Chat lanes",
      "GET",
      lanes,
      { client: "other", setup: [seedLane()] },
      ({ body }) => assert.deepEqual(body, []),
    );
    await test(
      "foreign Chat selection",
      "PATCH",
      worktree,
      { client: "other", json: input, status: 404 },
      error("Chat or worktree not found."),
    );
    await test(
      "foreign lane release",
      "POST",
      release(),
      { client: "other", setup: [seedLane()], status: 404 },
      error("Execution lane not found."),
    );
    await test(
      "foreign Chat compaction",
      "POST",
      compact,
      { client: "other", status: 404 },
      error("Chat source not found."),
    );
  }
  for (const [name, value] of [
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["wrong mode", { worktreeId: tree(1), mode: "unexpected" }],
    ["empty target", { worktreeId: "", mode: "pinned" }],
  ])
    await test(
      name + " selection input",
      "PATCH",
      worktree,
      { json: value, status: 400 },
      noCommands,
    );
  await test(
    "missing Chat selection",
    "PATCH",
    base("missing") + "/worktree",
    { json: input, status: 404 },
    error("Chat or worktree not found."),
  );
  await test(
    "standalone selection rejects project worktree",
    "PATCH",
    base(standalone) + "/worktree",
    { json: input, status: 409 },
    error("This IDE-only Chat feature is unavailable in standalone Chat."),
  );
  await test(
    "folder capability rejection",
    "PATCH",
    base(folderChat) + "/worktree",
    { json: input, status: 409 },
    ({ body, commands }) => {
      assert.equal(body.code, "project-capability-unavailable");
      assert.equal(body.capability, "worktrees");
      assert.deepEqual(commands, []);
    },
  );
  await test(
    "validation before capability rejection",
    "PATCH",
    base(folderChat) + "/worktree",
    { json: {}, status: 400 },
    noCommands,
  );
  await test(
    "unready target selection",
    "PATCH",
    worktree,
    { json: { ...input, worktreeId: tree(3) }, status: 404 },
    error("Chat or worktree not found."),
  );
  await test(
    "cross-worker selection before executing check",
    "PATCH",
    worktree,
    {
      setup: [`UPDATE chats SET status='running' WHERE id=${q(chat)}`],
      json: { ...input, worktreeId: tree(4) },
      status: 409,
    },
    error("Moving a chat to another worker requires a durable relocation."),
  );
  for (const status of ["running", "waiting-for-approval"])
    await test(
      status + " selection",
      "PATCH",
      worktree,
      {
        setup: [`UPDATE chats SET status=${q(status)} WHERE id=${q(chat)}`],
        json: input,
        status: 409,
      },
      error("Wait for the active chat turn before switching worktrees."),
    );
  await test(
    "active lane blocks selection",
    "PATCH",
    worktree,
    {
      setup: [seedLane({ t: primary, state: "active", exclusive: false })],
      json: input,
      status: 409,
    },
    error("Finish the active chat execution before switching worktrees."),
  );
  await test(
    "other Chat reservation blocks selection",
    "PATCH",
    worktree,
    { setup: [seedLane({ c: peer })], json: input, status: 409 },
    error(`Worktree is exclusively leased to chat ${peer}.`),
  );
  await test(
    "running console blocks selection",
    "PATCH",
    worktree,
    {
      setup: [
        `UPDATE terminals SET status='running' WHERE id='control-console'`,
      ],
      json: input,
      status: 409,
    },
    error("Stop the linked Codex console before switching worktrees."),
  );
  const selectionProof = ({ body, before, after, commands }) => {
    assert.equal(body.activeWorktreeId, tree(1));
    assert.equal(body.worktreeMode, "pinned");
    assert.equal(
      current(after).placement_revision,
      current(before).placement_revision + 1,
    );
    assert.equal(
      after.terminals.find((t) => t.id === "control-console").worktree_id,
      tree(1),
    );
    assert.ok(
      after.chat_execution_lanes.some(
        (l) =>
          l.chat_id === chat &&
          l.worktree_id === tree(1) &&
          l.state === "suspended",
      ),
    );
    assert.equal(after.chat_messages.length, 0);
    assert.deepEqual(commands, []);
  };
  await test(
    "selection creates runtime and suspended lane",
    "PATCH",
    worktree,
    { json: { ...input, ignored: "stripped" }, unchanged: false },
    selectionProof,
  );
  await settle(
    "same worktree reuses runtime and lane",
    "PATCH",
    worktree,
    { json: input, unchanged: false },
    ({ before, after, commands }) => {
      assert.equal(
        current(after).placement_revision,
        current(before).placement_revision,
      );
      assert.equal(
        after.chat_execution_lanes.length,
        before.chat_execution_lanes.length,
      );
      assert.equal(
        after.chat_runtime_sessions.length,
        before.chat_runtime_sessions.length,
      );
      assert.deepEqual(commands, []);
    },
  );
  await test(
    "same worktree permits mode change during execution",
    "PATCH",
    worktree,
    {
      setup: [`UPDATE chats SET status='running' WHERE id=${q(chat)}`],
      json: { worktreeId: primary, mode: "pinned" },
      unchanged: false,
    },
    ({ body, before, after }) => {
      assert.equal(body.worktreeMode, "pinned");
      assert.equal(
        current(after).placement_revision,
        current(before).placement_revision,
      );
    },
  );
  await test(
    "own reservation permits selection",
    "PATCH",
    worktree,
    { setup: [seedLane()], json: input, unchanged: false },
    selectionProof,
  );
  await test(
    "released other reservation permits selection",
    "PATCH",
    worktree,
    {
      setup: [seedLane({ c: peer, state: "released" })],
      json: input,
      unchanged: false,
    },
    selectionProof,
  );
  await test(
    "late selection failure rolls back placement runtime lane console",
    "PATCH",
    worktree,
    {
      setup: [
        `CREATE FUNCTION control_reject_chat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-selection-fault'; END $$`,
        `CREATE TRIGGER control_reject_chat BEFORE UPDATE ON chats FOR EACH ROW WHEN(OLD.id=${q(chat)}) EXECUTE FUNCTION control_reject_chat()`,
      ],
      json: input,
      status: 500,
    },
    error(
      "Could not update the agent worktree. Try again or reload the agent.",
    ),
  );
  await f.sql([
    "DROP TRIGGER control_reject_chat ON chats",
    "DROP FUNCTION control_reject_chat()",
  ]);

  for (const value of [
    [],
    1,
    { allowDirty: "true" },
    { returnToPrimary: null },
  ])
    await test(
      "invalid release " + JSON.stringify(value),
      "POST",
      release(),
      { json: value, status: 400 },
      noCommands,
    );
  await test(
    "missing lane release",
    "POST",
    release(),
    { status: 404 },
    error("Execution lane not found."),
  );
  await test(
    "offline release before busy checks",
    "POST",
    release(offlineChat),
    {
      setup: [
        seedLane({
          c: offlineChat,
          t: tree(4),
          w: offlineWorker,
          state: "active",
        }),
      ],
      status: 503,
    },
    error("Project worker is offline."),
  );
  await test(
    "released offline lane replay bypasses worker and busy checks",
    "POST",
    release(offlineChat),
    {
      setup: [
        seedLane({
          c: offlineChat,
          t: tree(4),
          w: offlineWorker,
          state: "released",
        }),
      ],
    },
    ({ body, commands }) => {
      assert.equal(body.returnedToPrimary, false);
      assert.deepEqual(commands, []);
    },
  );
  await test(
    "dirty lane rejection",
    "POST",
    release(),
    { setup: placed(), mode: "dirty", status: 409 },
    error(
      "This worktree has uncommitted changes. Pass allowDirty to release it intentionally.",
      ["worktree.status"],
    ),
  );
  await test(
    "active lane release rejection after status",
    "POST",
    release(),
    { setup: [seedLane({ state: "active" })], status: 409 },
    error("Finish the active chat execution before releasing its lane.", [
      "worktree.status",
    ]),
  );
  await test(
    "running Chat release rejection after status",
    "POST",
    release(),
    {
      setup: [
        ...placed(),
        `UPDATE chats SET status='running' WHERE id=${q(chat)}`,
      ],
      status: 409,
    },
    error("Finish the active chat execution before releasing its lane.", [
      "worktree.status",
    ]),
  );
  await test(
    "running console release rejection",
    "POST",
    release(),
    {
      setup: [
        ...placed(),
        `UPDATE terminals SET status='running' WHERE id='control-console'`,
      ],
      status: 409,
    },
    error("Stop the linked Codex console before releasing its lane.", [
      "worktree.status",
    ]),
  );
  await test(
    "unready Primary rolls back lane and branch lease release",
    "POST",
    release(),
    {
      setup: [
        ...placed(),
        `UPDATE project_worktrees SET lifecycle_state='provisioning' WHERE id=${q(primary)}`,
      ],
      status: 409,
    },
    error("Primary is not ready, so this lane cannot be released safely.", [
      "worktree.status",
    ]),
  );
  await test(
    "worker status failure preserves release state",
    "POST",
    release(),
    { setup: placed(), mode: "status-error", status: 409 },
    error("Controlled worktree status failure", ["worktree.status"]),
  );
  await test(
    "malformed worker status preserves release state",
    "POST",
    release(),
    { setup: placed(), mode: "status-invalid", status: 409 },
  );
  const releaseProof =
    (returned) =>
    ({ body, after, commands, events }) => {
      assert.equal(body.returnedToPrimary, returned);
      assert.equal(selected(after).state, "released");
      assert.equal(after.project_branch_leases[0].state, "released");
      assert.equal(
        current(after).active_worktree_id,
        returned ? primary : tree(1),
      );
      assert.deepEqual(
        commands.map((c) => c.type),
        ["worktree.status", "chat.message.protect"],
      );
      assert.equal(after.chat_messages.length, 1);
      const message = after.chat_messages[0];
      assert.equal(message.execution_lane_id, lane(1));
      assert.equal(message.worktree_id, tree(1));
      assert.equal(message.idempotency_key, "lane-release:" + lane(1));
      assert.deepEqual(
        events.map((e) => e.resource),
        ["chat-message", "chat"],
      );
      assert.deepEqual(commands[1].message.content, [
        {
          type: "text",
          text: returned
            ? "Released lane-1; execution returned to Primary."
            : "Released execution lane for lane-1.",
        },
      ]);
    };
  await test(
    "allow dirty release retains selected worktree",
    "POST",
    release(),
    {
      setup: placed(),
      mode: "dirty",
      json: { allowDirty: true, returnToPrimary: false },
      unchanged: false,
    },
    releaseProof(false),
  );
  await test(
    "default release returns to Primary and protects attributed message",
    "POST",
    release(),
    { setup: placed(), unchanged: false },
    releaseProof(true),
  );
  await settle(
    "released lane retry has no duplicate message or worker command",
    "POST",
    release(),
    { mode: "dirty", json: null },
    ({ body, commands }) => {
      assert.equal(body.returnedToPrimary, false);
      assert.deepEqual(commands, []);
    },
  );
  await test(
    "null release input defaults",
    "POST",
    release(),
    { setup: placed(), json: null, unchanged: false },
    releaseProof(true),
  );
  await test(
    "Task lane release does not request protected Chat message",
    "POST",
    release(),
    {
      setup: [
        ...placed(),
        `UPDATE chats SET experience='task' WHERE id=${q(chat)}`,
      ],
      unchanged: false,
    },
    ({ body, commands, after }) => {
      assert.equal(body.returnedToPrimary, true);
      assert.deepEqual(
        commands.map((c) => c.type),
        ["worktree.status"],
      );
      assert.deepEqual(after.chat_messages, []);
    },
  );
  await test(
    "message protection failure retains committed release",
    "POST",
    release(),
    { setup: placed(), mode: "protect-error", status: 409, unchanged: false },
    ({ body, after }) => {
      assert.equal(body.error, "Controlled release protection failure");
      assert.equal(selected(after).state, "released");
      assert.equal(current(after).active_worktree_id, primary);
      assert.deepEqual(after.chat_messages, []);
    },
  );
  await settle(
    "retry after protection failure uses released shortcut",
    "POST",
    release(),
    {},
    ({ body, commands, after }) => {
      assert.equal(body.returnedToPrimary, false);
      assert.deepEqual(commands, []);
      assert.deepEqual(after.chat_messages, []);
    },
  );

  await test(
    "missing Chat compaction",
    "POST",
    base("missing") + "/compact",
    { status: 404 },
    error("Chat source not found."),
  );
  for (const status of ["running", "waiting-for-approval"])
    await test(
      status + " compaction before thread check",
      "POST",
      compact,
      {
        setup: [
          `UPDATE chats SET status=${q(status)} WHERE id=${q(chat)}`,
          "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE id='settings-runtime'",
        ],
        status: 409,
      },
      error("Wait for the active turn to finish."),
    );
  await test(
    "threadless compaction",
    "POST",
    compact,
    {
      setup: [
        "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE id='settings-runtime'",
      ],
      status: 409,
    },
    error("Send a message before compacting this chat."),
  );
  await test(
    "offline compaction",
    "POST",
    base(offlineChat) + "/compact",
    { status: 503 },
    error("Project worker is offline."),
  );
  await test(
    "missing selected and bound model uses global error boundary",
    "POST",
    compact,
    {
      setup: [
        `UPDATE chats SET model_id=NULL WHERE id=${q(chat)}`,
        "UPDATE chat_runtime_sessions SET model_route_id=NULL WHERE id='settings-runtime'",
      ],
      status: 500,
    },
    error("Internal server error."),
  );
  const compactProof =
    (managed) =>
    ({ body, commands }) => {
      assert.deepEqual(body, { accepted: true });
      const command = commands.find((c) => c.type === "chat.compact");
      assert.ok(command);
      assert.equal(command.threadId, "thread");
      assert.equal(command.executionProfile, "ide");
      assert.equal(command.model.id, model);
      assert.equal(Object.hasOwn(command, "session"), managed);
      if (managed)
        for (const key of [
          "session",
          "subagentDefaults",
          "mcpServers",
          "planMode",
        ])
          assert.ok(Object.hasOwn(command, key), key);
    };
  await test(
    "managed compaction uses actual route and launch context",
    "POST",
    compact,
    { json: { ignored: "request body" }, unchanged: false },
    compactProof(true),
  );
  await test(
    "Task compaction omits managed launch fields",
    "POST",
    compact,
    { setup: [`UPDATE chats SET experience='task' WHERE id=${q(chat)}`] },
    compactProof(false),
  );
  await test(
    "standalone compaction retains original thread in command",
    "POST",
    base(standalone) + "/compact",
    { unchanged: false },
    ({ body, commands, after }) => {
      assert.deepEqual(body, { accepted: true });
      assert.deepEqual(
        commands.map((c) => c.type),
        ["chat.thread.ensure", "chat.compact"],
      );
      assert.equal(commands[1].threadId, "standalone-thread");
      assert.equal(commands[1].executionProfile, "standalone-chat");
      assert.equal(
        after.chat_runtime_sessions.find((r) => r.chat_id === standalone)
          .codex_thread_id,
        "ensured-standalone",
      );
    },
  );
  await test(
    "compaction worker failure uses global error response",
    "POST",
    compact,
    { mode: "compact-error", status: 500, unchanged: false },
  );
  await test(
    "invalid compaction acknowledgment uses global error response",
    "POST",
    compact,
    { mode: "compact-invalid", status: 500, unchanged: false },
  );
}
