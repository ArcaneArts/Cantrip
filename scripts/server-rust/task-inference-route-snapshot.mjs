import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { label, stamp } from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { taskEnvelope, taskStart } from "./task-wire-fixtures.mjs";

const executable = process.env.CANTRIP_RUST_SERVER_BINARY;
assert.ok(
  executable,
  "Set CANTRIP_RUST_SERVER_BINARY to the Rust server executable.",
);
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-route-snapshot-"));
const project = "task-route-snapshot-project";
const chat = "task-route-snapshot-chat";
const round = "12a34567-2345-4456-8567-567890123456";
const route = "/api/tasks/" + chat + "/inference-route";
const initial = taskStart("direct", chat, 1, 2, round);
const receipt = {
  operationId: "22a34567-2345-4456-8567-567890123456",
  chatId: chat,
  clientMessageId: initial.operation.userMessage.id,
  workerId: "task-route-snapshot-worker",
  worktreeId: "task-route-snapshot-tree",
  executionLaneId: "task-route-snapshot-lane",
  executionLaneActivatedAt: stamp,
  providerId: "source-provider",
  modelRouteId: "source-route",
  providerAccountId: null,
  dispatch: {
    cycleId: "42a34567-2345-4456-8567-567890123456",
    operationId: round,
    leaseOwner: "task-route-snapshot-lease",
    fencingToken: 7,
  },
};
const routeChange = {
  operationId: "32a34567-2345-4456-8567-567890123456",
  inputOperationId: receipt.operationId,
  expectedRevision: 2,
  targetModelRouteId: "destination-route",
  targetProviderAccountId: null,
  source: receipt,
  phase: "draining",
  queuedFencingToken: 9,
  createdAt: stamp,
  completedAt: null,
};
const input = {
  receipt,
  accepted: true,
  allAttemptsEnforced: true,
  routeChange,
};
const viewState = ({ revision, latest }) => ({ revision, phase: latest.phase });
const draining = { revision: 3, phase: "draining" };
const completed = { revision: 4, phase: "completed" };
let cluster, fixture, database;

try {
  cluster = await postgresFixture(path.join(root, "postgres"), {
    restartable: true,
  });
  const url = await cluster.database();
  database = postgres(url, { max: 2 });
  fixture = new HttpFixture({
    kind: "rust",
    executable,
    root,
    name: "task-route-snapshot",
    databaseMode: "postgres",
    environment: {
      CANTRIP_AUTH_MODE: "accounts",
      CANTRIP_REGISTRATION_ENABLED: "true",
      DATABASE_URL: url,
    },
  });
  await fixture.start();
  await fixture.observe("register", "POST", "/api/auth/register", {
    status: 201,
    json: {
      email: "task-route-snapshot@example.invalid",
      displayName: "Task route snapshot",
      password,
    },
  });
  const owner = fixture.records.get("register").currentUser.id;
  await database.begin(async (transaction) => {
    await transaction`INSERT INTO projects (id, owner_id, protected_label, origin_kind,
      git_capability, github_capability, github_repository_blind_index)
      VALUES (${project}, ${owner}, ${label("project")}, 'github', true, true, 'route-snapshot')`;
    await transaction`INSERT INTO workers (id, owner_id, name, platform, architecture, started_at, last_seen_at)
      VALUES (${receipt.workerId}, ${owner}, 'Snapshot worker', 'linux', 'arm64', now(), now())`;
    await transaction`INSERT INTO project_sources (id, project_id, worker_id, source_kind, absolute_path, display_path)
      VALUES ('snapshot-source', ${project}, ${receipt.workerId}, 'git', '/fixture/source', '/fixture/source')`;
    await transaction`INSERT INTO project_worktrees (id, project_source_id, worker_id, name, absolute_path,
      display_path, is_primary, origin, lifecycle_state)
      VALUES (${receipt.worktreeId}, 'snapshot-source', ${receipt.workerId}, 'main', '/fixture/source',
        '/fixture/source', true, 'cantrip', 'ready')`;
    await transaction`INSERT INTO chats (id, owner_id, project_id, protected_label, experience,
      active_worktree_id, active_worker_id)
      VALUES (${chat}, ${owner}, ${project}, ${label("chat")}, 'task', ${receipt.worktreeId}, ${receipt.workerId})`;
    await transaction`INSERT INTO tasks (chat_id, state, planning_round, active_operation_id,
      active_operation_kind, row_version, protected_content)
      VALUES (${chat}, 'implementing', 1, ${round}, 'direct', 3, ${taskEnvelope})`;
    await transaction`INSERT INTO task_planning_rounds (id, chat_id, ordinal, kind, status,
      protected_content, inference_input, relay_request, failure_task, failure_round)
      VALUES (${round}, ${chat}, 1, 'direct', 'running', ${taskEnvelope}, ${input},
        ${initial.operation}, ${initial.failure.task}, ${initial.failure.round})`;
  });

  async function read(name) {
    await fixture.observe(name, "GET", route);
    return fixture.records.get(name);
  }
  assert.deepEqual(viewState(await read("before settlement")), draining);

  let pending;
  try {
    await database.begin(async (writer) => {
      // Keep the GET waiting on the round table while changing the round and
      // Task revision in the same transaction, as settlement does.
      await writer`LOCK TABLE task_planning_rounds IN ACCESS EXCLUSIVE MODE`;
      const [{ pid }] = await writer`SELECT pg_backend_pid() AS pid`;
      pending = read("during settlement");
      pending.catch(() => {});
      const deadline = Date.now() + 10000;
      while (true) {
        const [waiting] = await database`SELECT 1 FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND ${pid} = ANY(pg_blocking_pids(pid))
            AND (query LIKE 'SELECT inference_input::text FROM task_planning_rounds%'
              OR (query LIKE 'SELECT jsonb_build_object(%' AND query LIKE '%t.row_version%'
                AND query LIKE '%r.inference_input FROM task_planning_rounds%'))`;
        if (waiting) break;
        assert.ok(
          Date.now() < deadline,
          "The HTTP route did not reach the held round table.",
        );
        await delay(20);
      }
      const settled = {
        ...input,
        routeChange: { ...routeChange, phase: "completed", completedAt: stamp },
      };
      await writer`UPDATE task_planning_rounds SET inference_input = ${settled} WHERE id = ${round}`;
      await writer`UPDATE tasks SET row_version = 4 WHERE chat_id = ${chat}`;
    });
  } catch (error) {
    await pending?.catch(() => {});
    throw error;
  }

  const during = viewState(await pending);
  const after = viewState(await read("after settlement"));
  console.log(JSON.stringify({ during, after }));
  assert.deepEqual(after, completed);
  assert.deepEqual(
    during,
    during.revision === draining.revision ? draining : completed,
  );
} finally {
  try {
    await fixture?.close();
  } finally {
    try {
      await database?.end({ timeout: 5 });
      await cluster?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
