// Real MCP relay, authentication, target repositories, live connection and audits.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { storedTargetCases } from "./agent-target-stored-cases.mjs";
import {
  targetStateSql,
  literal,
  json,
  label,
  state,
} from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-target-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-target-"));
const tree = `github-${worker}-main`;
const sourceQueries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/mcp-target-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
sourceQueries.worker = {
  sql: JSON.parse(
    await readFile(
      new URL(
        "../../cantrip_server_rs/contracts/mcp-read-queries.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).worker,
  params: ["fixture-target", "fixture-owner", 1],
};
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  databaseMode,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, postgres, failure;
try {
  const executable = peers.includes("rust")
    ? (process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")))
    : undefined;
  report.executable = executable;
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (value) => !option("--profile") || value === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of peers) {
      const result = { kind, observations: [], commands: [], calls: [] };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          postgres && (kind === "node" || databaseMode === "postgres")
            ? await postgres.database()
            : undefined,
        onCommand: async (command) => {
          result.commands.push({ type: command.type });
        },
      });
      try {
        await h.fixture.sql([
          ...targetStateSql(h.owner)
            .filter(
              (sql) =>
                !sql.startsWith("INSERT INTO workers") ||
                !sql.includes("VALUES('alpha',"),
            )
            .map((sql) => sql.replaceAll("alpha", worker)),
          `UPDATE chats SET project_id='github',active_worktree_id=${literal(tree)},status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `UPDATE chat_runtime_sessions SET worktree_id=${literal(tree)} WHERE id='settings-runtime'`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-target-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const binding = {
          bindingId: "eeeeeeee-eeee-4eee-8eee-000000000600",
          ownerId: h.owner,
          contextKind: "project",
          projectId: "github",
          chatId: chat,
          executionLaneId: "mcp-target-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: ["context.get", "target.list", "target.inspect"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        async function call(
          name,
          operation,
          args = {},
          status = 200,
          claims = binding,
        ) {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + h.credential,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          const comparison = structuredClone(body);
          if (comparison.data && Object.hasOwn(comparison.data, "serverId")) {
            assert.equal(comparison.data.serverId, h.serverId);
            comparison.data.serverId = "<verified server identity>";
          }
          // Source's Promise.all exposes either real failing lookup. Retained
          // v4/v5 Source runs demonstrate both desktop outcomes. Verify every
          // statement and original parameter before comparing that race.
          // Independent account fixtures have different actual owner IDs.
          let concurrentQuery;
          if (
            response.status === 400 &&
            (args.target?.surfaceId === "\u0000" ||
              args.target?.workerId === "\u0000")
          ) {
            const kind =
              args.target.kind === "worker"
                ? "worker"
                : args.target.surfaceKind;
            const keys =
              kind === "browser" || kind === "remote-desktop"
                ? ["remote", kind === "browser" ? "browser" : "desktop"]
                : [
                    kind === "chat"
                      ? "chatIdentity"
                      : kind === "remote-surface"
                        ? "remote"
                        : kind,
                  ];
            const diagnostic = (key, owner) => {
              const query = sourceQueries[key];
              const params = query.params.map((value) =>
                value === "fixture-owner"
                  ? owner
                  : value === "fixture-target"
                    ? (args.target.surfaceId ?? args.target.workerId)
                    : value,
              );
              return `Failed query: ${query.sql}\nparams: ${params.join(",")}`.slice(
                0,
                2000,
              );
            };
            const expected = keys.map((key) => diagnostic(key, h.owner));
            assert.equal(body.code, "invalid");
            const matched = expected.indexOf(body.error);
            assert.ok(
              matched >= 0,
              "Failed lookup must contain an actual Source query and original parameters",
            );
            concurrentQuery = keys[matched];
            comparison.error =
              keys.length > 1
                ? "<verified first failure from concurrent target lookups>"
                : diagnostic(keys[matched], "<verified owning account>");
          }
          result.calls.push({
            name,
            operation,
            args,
            status: response.status,
            body,
            comparison,
            concurrentQuery,
            httpRequestId: response.headers.get("x-request-id"),
          });
          assert.equal(
            response.status,
            status,
            JSON.stringify({ kind, name, body }),
          );
          return body;
        }
        const list = (name, args, status, claims) =>
          call(name, "target.list", args, status, claims);
        const inspect = (name, target, status = 200) =>
          call(name, "target.inspect", { target }, status);
        const caps = await fetch(
          h.fixture.server.origin +
            "/api/internal/agent-operations/capabilities?workerId=" +
            worker,
          {
            headers: { authorization: "Bearer " + h.credential },
            signal: AbortSignal.timeout(15000),
          },
        );
        assert.equal(caps.status, 200);
        result.capabilities = await caps.json();
        for (const operation of ["target.list", "target.inspect"])
          assert.ok(result.capabilities.operations.includes(operation));
        const catalog = await list("all owned targets");
        assert.equal(catalog.data.truncated, false);
        assert.ok(catalog.data.targets.length > 10);
        assert.ok(
          catalog.data.targets.every(
            (target) =>
              target.target.projectId === "github" &&
              target.worker.workerId !== "foreign",
          ),
        );
        assert.ok(
          catalog.data.targets.some(
            (target) =>
              target.worker.workerId === worker &&
              target.availability === "available",
          ),
        );
        assert.ok(
          catalog.data.targets.some(
            (target) =>
              target.worker.workerId === "beta" &&
              target.availability === "worker-offline",
          ),
        );
        for (const resourceKind of [
          "project",
          "worker",
          "replica",
          "worktree",
          "chat",
          "terminal",
          "explorer",
          "code",
          "browser",
          "remote-desktop",
          "remote-surface",
        ]) {
          const filtered = await list("kind " + resourceKind, {
            kind: resourceKind,
          });
          assert.deepEqual(
            filtered.data.targets,
            catalog.data.targets.filter(
              (target) => target.resourceKind === resourceKind,
            ),
          );
        }
        for (const value of [null, "", " \t\ufeff"])
          assert.deepEqual(
            (await list("empty kind " + JSON.stringify(value), { kind: value }))
              .data,
            catalog.data,
          );
        assert.deepEqual(
          (
            await list("JavaScript Unicode trim", {
              kind: "\ufeffterminal\u00a0",
            })
          ).data.targets,
          catalog.data.targets.filter(
            (target) => target.resourceKind === "terminal",
          ),
        );
        for (const value of [1, false, [], {}])
          await list(
            "non-string kind " + JSON.stringify(value),
            { kind: value },
            400,
          );
        await list("unknown kind", { kind: "unknown" }, 400);
        const first = await list("first page", { cursor: 0, limit: 2 });
        assert.deepEqual(first.data.targets, catalog.data.targets.slice(0, 2));
        assert.equal(first.data.nextCursor, 2);
        assert.equal(first.data.total, catalog.data.targets.length);
        assert.equal(first.data.truncated, true);
        const second = await list("second page", { cursor: 2, limit: 2 });
        assert.deepEqual(second.data.targets, catalog.data.targets.slice(2, 4));
        await list("null paging selects defaults", {
          cursor: null,
          limit: null,
        });
        await list("maximum cursor beyond catalog", {
          cursor: 1999,
          limit: 200,
        });
        for (const args of [
          { cursor: -1 },
          { cursor: 2000 },
          { cursor: 0.5 },
          { cursor: "1" },
          { cursor: false },
          { limit: 0 },
          { limit: 201 },
          { limit: 1.5 },
          { limit: "1" },
          { limit: true },
          { cursor: -1, limit: 0 },
        ])
          await list("invalid paging " + JSON.stringify(args), args, 400);
        await inspect("project placement", {
          kind: "project",
          projectId: "github",
        });
        for (const descriptor of catalog.data.targets) {
          const resolved = await inspect(
            "inspect " + JSON.stringify(descriptor.target),
            descriptor.target,
          );
          assert.equal(resolved.data.availability, descriptor.availability);
          assert.equal(
            resolved.data.worker.workerId,
            descriptor.worker.workerId,
          );
          assert.equal(resolved.target.projectId, "github");
        }
        const browser = {
          kind: "surface",
          projectId: "github",
          surfaceKind: "browser",
          surfaceId: "browser",
        };
        await h.fixture.sql([
          "UPDATE browsers SET state_revision=17 WHERE id='browser'",
          "UPDATE remote_surfaces SET state_revision=19 WHERE id='browser'",
        ]);
        assert.equal(
          (await inspect("browser revision follows concrete browser", browser))
            .data.stateRevision,
          17,
        );
        await h.fixture.sql([
          `UPDATE project_worktrees SET lifecycle_state='removing' WHERE id=${literal(tree)}`,
        ]);
        assert.equal(
          (
            await inspect("unavailable worktree remains inspectable", {
              kind: "worktree",
              projectId: "github",
              worktreeId: tree,
            })
          ).data.availability,
          "resource-unavailable",
        );
        await h.fixture.sql([
          `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${literal(tree)}`,
        ]);
        for (const target of [
          null,
          {},
          { kind: "unknown", projectId: "github" },
          { kind: "worker", projectId: "github" },
        ])
          await inspect(
            "invalid target " + JSON.stringify(target),
            target,
            400,
          );
        await call("missing target", "target.inspect", {}, 400);
        await inspect(
          "cross-project target",
          { kind: "project", projectId: "other" },
          409,
        );
        await inspect(
          "foreign worker",
          { kind: "worker", projectId: "github", workerId: "foreign" },
          409,
        );
        await inspect(
          "foreign surface",
          {
            kind: "surface",
            projectId: "github",
            surfaceKind: "browser",
            surfaceId: "other-browser",
          },
          409,
        );
        await inspect(
          "missing worktree",
          { kind: "worktree", projectId: "github", worktreeId: "missing" },
          409,
        );
        await inspect("UTF-16 worker lookup keeps Source parameter encoding", {
          kind: "worker",
          projectId: "github",
          workerId: "\ud800",
        });
        await inspect("UTF-16 surface lookup keeps Source parameter encoding", {
          kind: "surface",
          projectId: "github",
          surfaceKind: "terminal",
          surfaceId: "\ud800",
        });
        await inspect(
          "actual invalid database text parameter",
          {
            kind: "worker",
            projectId: "github",
            workerId: "\u0000",
          },
          400,
        );
        await inspect(
          "invalid text remains an in-memory replica miss",
          {
            kind: "replica",
            projectId: "github",
            projectReplicaId: "\u0000",
          },
          409,
        );
        await inspect(
          "invalid text remains an in-memory worktree miss",
          {
            kind: "worktree",
            projectId: "github",
            worktreeId: "\u0000",
          },
          409,
        );
        for (const surfaceKind of [
          "chat",
          "terminal",
          "explorer",
          "code",
          "browser",
          "remote-desktop",
          "remote-surface",
        ]) {
          await inspect(
            "actual invalid text for " + surfaceKind,
            {
              kind: "surface",
              projectId: "github",
              surfaceKind,
              surfaceId: "\u0000",
            },
            400,
          );
        }
        await list("grant required", {}, 403, {
          ...binding,
          allowedOperations: ["context.get"],
        });
        await list("foreign binding owner", {}, 403, {
          ...binding,
          ownerId: "target-foreign-owner",
        });
        await list("stale project binding", {}, 409, {
          ...binding,
          projectId: "other",
        });
        await list("safe discovery follows current lane", {}, 200, {
          ...binding,
          executionLaneId: "old-target-lane",
          worktreeId: "old-target-tree",
          permissionProfileId: ":read-only",
        });
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await list("read-only discovery");
        await inspect("read-only inspection", browser);
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':workspace',status='idle' WHERE id=${literal(chat)}`,
        ]);
        await list("inactive chat denied", {}, 409);
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        await storedTargetCases({ fixture: h.fixture, call });
        // More than 2,000 physical owned resources exercises the catalog's real cap.
        await h.fixture.sql([
          `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state) SELECT 'mcp-target-overflow-'||i,'github',${literal(worker)},${literal(tree)},${json(label("terminal"))},${json(state("terminal-state"))} FROM generate_series(1,2001) i`,
        ]);
        const overflow = await list("catalog hard limit");
        assert.equal(overflow.data.targets.length, 2000);
        assert.equal(overflow.data.truncated, true);
        const overflowPage = await list(
          "pagination preserves upstream truncation",
          { cursor: 1999, limit: 1 },
        );
        assert.equal(overflowPage.data.nextCursor, null);
        assert.equal(overflowPage.data.truncated, true);
        await h.fixture.sql([
          "DELETE FROM terminals WHERE id LIKE 'mcp-target-overflow-%'",
        ]);
        h.worker.close();
        await h.live.close();
        const port = Number(new URL(h.fixture.server.origin).port);
        await h.fixture.close();
        await h.fixture.start({ port });
        await h.reconnectWorker();
        await list("restart fences old execution", {}, 409);
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        binding.issuedAt = new Date().toISOString();
        binding.expiresAt = new Date(Date.now() + 120000).toISOString();
        assert.equal(
          (await inspect("browser revision survives restart", browser)).data
            .stateRevision,
          17,
        );
        result.actualServerRestartVerified = true;
        const standalone = "eeeeeeee-eeee-4eee-8eee-000000000608";
        await h.fixture.sql([
          `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES(${literal(standalone)},${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'mcp-target-scratch',NULL,'running',':workspace')`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('mcp-target-scratch',${literal(standalone)},${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('mcp-target-standalone-runtime',${literal(standalone)},${literal(worker)},'mcp-target-scratch','mcp-target-standalone-thread')`,
          `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-target-standalone-lane',${literal(standalone)},'mcp-target-scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'mcp-target-standalone-runtime')`,
        ]);
        for (const operation of ["target.list", "target.inspect"]) {
          assert.deepEqual(
            await call("standalone " + operation, operation, {}, 409, {
              ...binding,
              contextKind: "standalone",
              projectId: null,
              chatId: standalone,
              executionLaneId: "mcp-target-standalone-lane",
              worktreeId: null,
              rootKind: null,
              scratchRootId: "mcp-target-scratch",
            }),
            {
              code: "unsupported-capability",
              error:
                "Standalone Chats do not support IDE execution operations.",
            },
          );
        }
        const [audit] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        assert.equal(audit.events.length, result.calls.length);
        const requests = new Map(
          result.calls.map((call) => [call.httpRequestId, call]),
        );
        result.auditEvents = audit.events.map((event) => {
          const call = requests.get(event.request_id);
          assert.ok(call);
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          assert.equal(event.resource_type, "mcp-binding");
          assert.equal(event.resource_id, binding.bindingId);
          const action =
            call.status === 200
              ? "mcp.operation.executed"
              : "mcp.operation.rejected";
          const outcome =
            call.status === 200
              ? "succeeded"
              : ["forbidden", "stale-binding", "expired"].includes(
                    call.body.code,
                  )
                ? "denied"
                : "failed";
          assert.equal(event.action, action);
          assert.equal(event.result, outcome);
          return { name: call.name, action, result: outcome };
        });
      } finally {
        result.diagnostics = h.diagnostics();
        await h.close();
        h = undefined;
      }
    }
    if (p.peers.length === 2) {
      const compact = (peer) =>
        peer.calls.map(({ name, status, comparison }) => ({
          name,
          status,
          body: comparison,
        }));
      const expected = compact(p.peers[0]),
        actual = compact(p.peers[1]);
      assert.equal(actual.length, expected.length);
      for (let index = 0; index < expected.length; index++) {
        assert.deepEqual(
          actual[index],
          expected[index],
          "Rust MCP target behavior matches Source: " + expected[index].name,
        );
      }
      assert.deepEqual(p.peers[1].auditEvents, p.peers[0].auditEvents);
    }
  }
  report.sourceAssertionsPassed = true;
  report.compatibilityPassed = peers.length === 2;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await postgres?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        calls: p.peers.map((peer) => peer.calls.length),
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
