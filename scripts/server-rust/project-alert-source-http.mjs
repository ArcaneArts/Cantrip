// Real worker-authenticated HTTP calls, source transitions and replay fences.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { buildRustServer } from "./build.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-alert-source-http-"));
let owner;
const opaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  },
};
try {
  const executable =
    process.env.CANTRIP_TEST_SERVER_EXECUTABLE ?? (await buildRustServer());
  owner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const url = await owner.database();
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "sources",
      databaseMode: "postgres",
      environment: { CANTRIP_AUTH_MODE: "none", DATABASE_URL: url },
    });
    const sql = postgres(url);
    try {
      await fixture.start();
      await fixture.observe("session", "GET", "/api/auth/session");
      const [{ value }] =
        await sql`SELECT value FROM system_state WHERE key='server-id'`;
      const serverId = value.id;
      assert.ok(serverId, "Server identity");
      const user = "00000000-0000-0000-0000-000000000001";
      await sql.unsafe(
        `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('project','${user}','{}','A'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('worker','${user}','Worker','linux','x64',now(),now()); INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('source','project','worker','/qa','/qa'); INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin,is_primary) VALUES ('tree','source','worker','Primary','/qa','/qa','cantrip',true); INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id,status,permission_profile_id) VALUES ('chat','${user}','project','{}','tree','running',':workspace'); INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES ('runtime','chat','worker','tree','thread'); INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES ('lane','chat','tree','worker','agent',false,'Qualification','active',now(),'runtime')`,
      );
      const generation = randomUUID();
      await sql`UPDATE workers SET project_goal_generation=${generation} WHERE id='worker'`;
      const headers = {
        authorization: "Bearer " + fixture.environment.CANTRIP_WORKER_TOKEN,
      };
      const post = async (
        label,
        url,
        json,
        status = 200,
        authenticated = true,
      ) => {
        await fixture.observe(label, "POST", url, {
          json,
          status,
          client: "worker",
          headers: authenticated ? headers : {},
        });
        return fixture.records.get(label);
      };
      const counts = async (expected) => {
        await fixture.observe("counts", "GET", "/api/project-alerts/counts");
        assert.deepEqual(
          fixture.records.get("counts"),
          expected ? [{ projectId: "project", count: expected }] : [],
        );
      };
      const fact = (revision, status) => ({
        chatId: "chat",
        workerId: "worker",
        threadId: "thread",
        generation,
        revision,
        snapshot: {
          kind: "chat-encrypted",
          goal: status
            ? {
                threadId: "thread",
                status,
                tokenBudget: null,
                tokensUsed: 1,
                timeUsedSeconds: 1,
                createdAt: 1,
                updatedAt: 2,
                protectedObjective: {
                  id: randomUUID(),
                  classification: {
                    role: "user",
                    mode: "goal",
                    attachmentIds: [],
                  },
                  protectedContent: opaque,
                  idempotencyKey: "goal",
                },
              }
            : null,
        },
      });
      await post(
        "unauthorized fact",
        "/api/internal/project-alerts/goals",
        fact(1, "blocked"),
        401,
        false,
      );
      await post(
        "blocked fact",
        "/api/internal/project-alerts/goals",
        fact(1, "blocked"),
      );
      await counts(1);
      await post(
        "resumed fact",
        "/api/internal/project-alerts/goals",
        fact(2, "active"),
      );
      await post(
        "stale fact",
        "/api/internal/project-alerts/goals",
        fact(1, "blocked"),
      );
      await counts(0);
      const retired = await post(
        "retired process",
        "/api/internal/project-alerts/goals",
        { ...fact(3, "blocked"), generation: randomUUID() },
      );
      assert.equal(retired.reason, "retired-worker");
      await counts(0);
      const binding = {
        bindingId: randomUUID(),
        ownerId: user,
        contextKind: "project",
        projectId: "project",
        chatId: "chat",
        executionLaneId: "lane",
        workerId: "worker",
        worktreeId: "tree",
        rootKind: "git-worktree",
        scratchRootId: null,
        permissionProfileId: ":workspace",
        allowedOperations: ["context.get", "alert.raise", "alert.resolve"],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      const call = (operation, args) => ({
        requestId: randomUUID(),
        binding,
        request: { operation, arguments: args },
      });
      await post(
        "context",
        "/api/internal/agent-operations",
        call("context.get", {}),
      );
      const key = randomUUID();
      const mutation = (revision, status, scopeId = "chat") => ({
        key,
        revision,
        status,
        kind: "blocked",
        protectedDetail: {
          context: {
            domain: "alert-content",
            serverId,
            workerId: "worker",
            scopeId,
            operationId: key,
            operation: "agent-alert",
            direction: "stored",
            sequence: revision,
          },
          protectedContent: { ...opaque, domain: "alert-content" },
        },
      });
      await post(
        "unauthorized tool",
        "/api/internal/agent-operations",
        call("alert.raise", mutation(1, "open")),
        401,
        false,
      );
      await post(
        "raise",
        "/api/internal/agent-operations",
        call("alert.raise", mutation(1, "open")),
      );
      await post(
        "duplicate raise",
        "/api/internal/agent-operations",
        call("alert.raise", mutation(1, "open")),
      );
      await counts(1);
      await post(
        "foreign aad",
        "/api/internal/agent-operations",
        call("alert.resolve", mutation(2, "resolved", "foreign")),
        403,
      );
      await counts(1);
      await post(
        "resolve",
        "/api/internal/agent-operations",
        call("alert.resolve", mutation(2, "resolved")),
      );
      await post(
        "late raise",
        "/api/internal/agent-operations",
        call("alert.raise", mutation(3, "open")),
      );
      await counts(0);
      console.log(`${kind}: Goal observations and scoped AI Alert HTTP passed`);
    } finally {
      await fixture.close();
      await sql.end();
    }
  }
} finally {
  await owner?.close();
  await rm(root, { recursive: true, force: true });
}
