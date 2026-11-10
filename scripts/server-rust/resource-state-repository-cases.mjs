import assert from "node:assert/strict";
import {
  createInput,
  taskIds,
  literal,
  stamp,
} from "./resource-state-fixtures.mjs";

export async function resourceStateCases(h) {
  const { observe, seed, reopen, owner, other } = h;
  for (const [model, principal, expected] of [
    ["model", owner, { present: true, value: "high" }],
    ["null-model", owner, { present: true, value: null }],
    ["missing", owner, { present: false, value: null }],
    ["foreign-model", owner, { present: false, value: null }],
    ["model", other, { present: false, value: null }],
    ["foreign-model", other, { present: true, value: "low" }],
  ])
    await observe(
      "owned model default " + model + ":" + principal,
      "model-default",
      { model, owner: principal },
      { expected },
    );
  await seed(
    "ALTER TABLE model_profiles RENAME COLUMN default_reasoning_effort TO fixture_reasoning_default",
  );
  await observe(
    "actual model-default query failure retains all rows",
    "model-default",
    { model: "model" },
    { rejected: true },
  );
  await seed(
    "ALTER TABLE model_profiles RENAME COLUMN fixture_reasoning_default TO default_reasoning_effort",
  );
  await observe(
    "missing project has empty position",
    "next-position",
    { project: "missing" },
    { expected: 0 },
  );
  await observe(
    "six existing resource kinds share position",
    "next-position",
    {},
    { expected: 1 },
  );
  const tables = [
    "chats",
    "terminals",
    "explorers",
    "code_tabs",
    "browsers",
    "project_views",
  ];
  for (const [i, table] of tables.entries()) {
    await seed(
      `UPDATE ${table} SET position=${i + 2} WHERE project_id='github'`,
    );
    await observe(
      "position reads " + table,
      "next-position",
      {},
      { expected: i + 3 },
    );
  }
  await seed(
    `UPDATE chats SET position=100,archived_at=${literal(stamp)} WHERE id='chat'`,
  );
  await observe(
    "archived chat position is excluded",
    "next-position",
    {},
    { expected: 8 },
  );
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat'");
  for (const table of tables)
    await seed(`UPDATE ${table} SET position=-2 WHERE project_id='github'`);
  await observe(
    "all populated tables retain negative maxima",
    "next-position",
    {},
    { expected: -1 },
  );
  await seed("UPDATE browsers SET project_id='folder' WHERE id='browser'");
  await observe(
    "an empty table contributes minus one",
    "next-position",
    {},
    { expected: 0 },
  );
  await seed("UPDATE browsers SET project_id='github' WHERE id='browser'");
  for (const table of tables)
    await seed(`UPDATE ${table} SET position=0 WHERE project_id='github'`);

  for (const op of ["reorder", "reorder-layout"]) {
    for (const ids of [
      [],
      ["github"],
      ["github", "folder", "other"],
      ["github", "github", "folder"],
    ])
      await observe(
        op + " rejects incomplete or foreign set " + JSON.stringify(ids),
        op,
        { input: { ids } },
        { expected: false },
      );
    await observe(
      op + " assigns complete owned order",
      op,
      { input: { ids: ["local-git", "folder", "github"] } },
      {
        expected: true,
        unchanged: false,
        check: ({ before, after }) => {
          for (const row of after.projects) {
            const old = before.projects.find((p) => p.id === row.id);
            assert.equal(row.updated_at, old.updated_at);
            assert.equal(
              row.position,
              row.owner_id === owner
                ? ["local-git", "folder", "github"].indexOf(row.id)
                : old.position,
            );
          }
        },
      },
    );
  }
  // Only a later UPDATE fails, after this transaction has changed another row.
  await seed(
    "ALTER TABLE projects ADD CONSTRAINT fixture_project_order CHECK(id <> 'folder' OR position <> 1) NOT VALID",
  );
  await observe(
    "project order rolls back earlier updates on actual constraint failure",
    "reorder",
    { input: { ids: ["github", "folder", "local-git"] } },
    { rejected: true },
  );
  await seed("ALTER TABLE projects DROP CONSTRAINT fixture_project_order");
  await reopen("ordered projects and existing resources");

  const first = createInput(0, {
    worktreeId: "github-alpha-main",
    autoTitle: true,
  });
  await observe(
    "create Task with current account defaults",
    "create-task",
    { input: first },
    {
      unchanged: false,
      check: ({ before, response, after }) => {
        assert.equal(response.value.chat.experience, "task");
        assert.equal(response.value.task.chatId, taskIds[0]);
        assert.equal(response.value.chat.modelId, "model");
        assert.deepEqual(response.value.task.modelConfiguration, {
          modelId: "model",
          reasoningEffort: "medium",
          customSubagentModel: true,
          subagentModelId: "null-model",
          subagentReasoningEffort: "low",
        });
        assert.deepEqual(after.tab_groups, before.tab_groups);
        assert.deepEqual(after.tab_group_members, before.tab_group_members);
        const runtime = after.chat_runtime_sessions.find(
          (r) => r.chat_id === taskIds[0],
        );
        const lane = after.chat_execution_lanes.find(
          (r) => r.chat_id === taskIds[0],
        );
        assert.equal(lane.runtime_session_id, runtime.id);
        assert.equal(lane.state, "suspended");
        assert.equal(lane.exclusive, false);
      },
    },
  );
  await observe(
    "Task duplicate rolls back instead of inventing replay",
    "create-task",
    { input: first },
    { rejected: true },
  );
  await observe(
    "explicit Task configuration stays distinct from Chat defaults",
    "create-task",
    {
      input: createInput(1, {
        priority: 7,
        planGoalEnabled: true,
        paneId: "unused-task-pane",
        target: {
          kind: "worktree",
          projectId: "github",
          worktreeId: "github-beta-main",
        },
        modelConfiguration: {
          modelId: null,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        },
      }),
      connected: ["beta"],
    },
    {
      unchanged: false,
      check: ({ response }) => {
        assert.equal(response.value.chat.activeWorkerId, "beta");
        assert.equal(response.value.chat.modelId, "model");
        assert.equal(response.value.task.modelConfiguration.modelId, null);
        assert.equal(response.value.task.priority, 7);
        assert.equal(response.value.task.planGoalEnabled, true);
      },
    },
  );
  for (const project of ["missing", "other"])
    await observe(
      "Task creation hides unavailable project " + project,
      "create-task",
      { project, input: createInput(2) },
      { rejected: true },
    );
  await seed(
    "ALTER TABLE tasks ADD CONSTRAINT fixture_task_insert CHECK(priority <> 13)",
  );
  await observe(
    "Task row failure rolls back Chat runtime and lane",
    "create-task",
    {
      input: createInput(2, { worktreeId: "github-alpha-main", priority: 13 }),
    },
    { rejected: true },
  );
  await seed("ALTER TABLE tasks DROP CONSTRAINT fixture_task_insert");
  await reopen("created Tasks retain opaque content and execution bindings");

  for (const chat of ["missing", "other-chat"])
    await observe(
      "pause hides unavailable Chat " + chat,
      "pause",
      { chat, paused: true },
      { expected: null },
    );
  for (const chat of ["chat", taskIds[0]]) {
    for (const paused of [true, true, false])
      await observe(
        "pause state and queue revision " + chat + ":" + paused,
        "pause",
        { chat, paused },
        {
          unchanged: false,
          check: ({ before, after, response }) => {
            assert.equal(response.value.automationPaused, paused);
            const row = after.chats.find((r) => r.id === chat),
              old = before.chats.find((r) => r.id === chat);
            assert.equal(
              row.managed_input_revision,
              old.managed_input_revision + (chat === "chat" ? 0 : 1),
            );
            const queue = after.managed_queue_states.find(
              (r) => r.chat_id === chat,
            );
            const prior = before.managed_queue_states.find(
              (r) => r.chat_id === chat,
            );
            if (chat === "chat") assert.deepEqual(queue, prior);
            else assert.equal(queue.revision, (prior?.revision ?? 0) + 1);
          },
        },
      );
  }
  await seed(
    `INSERT INTO managed_queue_states(chat_id,revision) VALUES('chat',4)`,
  );
  await observe(
    "agent pause increments an existing queue only",
    "pause",
    { paused: true },
    {
      unchanged: false,
      check: ({ after }) =>
        assert.equal(
          after.managed_queue_states.find((r) => r.chat_id === "chat").revision,
          5,
        ),
    },
  );
  await seed(
    "ALTER TABLE managed_queue_states ADD CONSTRAINT fixture_pause_failure CHECK(revision < 4) NOT VALID",
  );
  await observe(
    "queue failure rolls back Chat pause and revision",
    "pause",
    { chat: taskIds[0], paused: true },
    { rejected: true },
  );
  await seed(
    "ALTER TABLE managed_queue_states DROP CONSTRAINT fixture_pause_failure",
  );
  await reopen("pause flags and queue revisions");

  for (const previous of ["idle", "running", "waiting-for-approval", "failed"])
    for (const status of [
      "idle",
      "running",
      "waiting-for-approval",
      "failed",
    ]) {
      await seed(
        `UPDATE chats SET status=${literal(previous)},has_unread_completion=false,updated_at=${literal(stamp)} WHERE id='chat'`,
      );
      await observe(
        "completion transition " + previous + " to " + status,
        "status",
        { status },
        {
          unchanged: false,
          expected: null,
          check: ({ after }) => {
            const chat = after.chats.find((r) => r.id === "chat");
            assert.equal(chat.status, status);
            assert.equal(
              chat.has_unread_completion,
              ["running", "waiting-for-approval"].includes(previous) &&
                ["idle", "failed"].includes(status),
            );
          },
        },
      );
    }
  await seed("UPDATE chats SET has_unread_completion=true WHERE id='chat'");
  await observe(
    "status retains previous unread completion",
    "status",
    { status: "idle" },
    {
      unchanged: false,
      check: ({ after }) =>
        assert.equal(
          after.chats.find((r) => r.id === "chat").has_unread_completion,
          true,
        ),
    },
  );
  await observe(
    "status missing target is a completed zero-row write",
    "status",
    { chat: "missing", status: "idle" },
    { expected: null },
  );
  await seed(
    "ALTER TABLE chats ADD CONSTRAINT fixture_status_failure CHECK(status <> 'failed') NOT VALID",
  );
  await observe(
    "actual status failure retains previous row and clock",
    "status",
    { status: "failed" },
    { rejected: true },
  );
  await seed("ALTER TABLE chats DROP CONSTRAINT fixture_status_failure");
  await reopen("completion status and unread flags");
}
