// Real MCP authentication, WorkerConnection and durable SQL state; Git command
// responses are controlled. This does not claim a full worker/native product run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { captureTaskRuntimeState } from "./task-runtime-snapshot.mjs";
import { worktreeDisconnectCase } from "./agent-worktree-http-disconnect.mjs";
import {
  worktreeReadBoundaries,
  worktreeRemovalBoundaries,
  worktreeFinalBoundaries,
  verifyTransitionQueryError,
} from "./agent-worktree-http-boundaries.mjs";
import { label, literal, json } from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  sourcePath,
  managedRoot,
  agentTree,
  userTree,
  operations,
  worktreeWorker,
} from "./agent-worktree-http-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-worktrees-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-worktrees-"));
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
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of peers) {
      const result = {
        kind,
        calls: [],
        snapshots: [],
        observations: [],
        snapshotProofs: 0,
      };
      p.peers.push(result);
      const state = worktreeWorker(),
        began = Date.now(),
        aliases = new Map();
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
        onCommand: state.onCommand,
      });
      aliases.set(h.owner, "<owner>");
      aliases.set(h.serverId, "<server>");
      try {
        await h.fixture.sql([
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-worktree-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
          ...[
            [agentTree, "Agent", "agent", "feature-a", "agent"],
            [userTree, "User", "user", "feature-u", "user"],
          ].map(
            ([id, name, origin, branch, leaf]) =>
              `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,head) VALUES(${literal(id)},'settings-source',${literal(worker)},${literal(name)},${literal(managedRoot + "/" + leaf)},${literal(managedRoot + "/" + leaf)},false,${literal(origin)},'ready',${literal(branch)},${literal("a".repeat(40))})`,
          ),
        ]);
        const binding = {
          bindingId: "eeeeeeee-eeee-4eee-8eee-000000000800",
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-worktree-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: operations,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 240000).toISOString(),
        };
        const normalize = (value, key) => {
          if (typeof value === "string") {
            for (const [id, alias] of aliases)
              value = value.replaceAll(id, alias);
            if (
              /(?:At|_at)$/.test(key ?? "") &&
              Number.isFinite(Date.parse(value))
            ) {
              // Historical fixture clocks remain literal, so ordering and values
              // are compared in full rather than normalized as generated time.
              if (/^2020-01-0[1-5]T/.test(value)) return value;
              assert.ok(
                Date.parse(value) >= began - 1000 &&
                  Date.parse(value) <= Date.now() + 1000,
                "actual generated clock is bounded",
              );
              return "<verified generated clock>";
            }
            return value;
          }
          if (Array.isArray(value)) return value.map((v) => normalize(v, key));
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
            );
          return value;
        };
        let createSequence = 0;
        const call = async (
          name,
          action,
          args = {},
          expected = 200,
          claims = binding,
        ) => {
          const operation = action.startsWith("worktree.")
              ? action
              : "worktree." + action,
            start = state.commands.length;
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
          const body = await response.json(),
            commands = state.commands.slice(start);
          result.calls.push({
            name,
            operation,
            args,
            status: response.status,
            body,
            commands,
            httpRequestId: response.headers.get("x-request-id"),
          });
          assert.equal(
            response.status,
            expected,
            JSON.stringify({ kind, name, body }),
          );
          for (const command of commands)
            if (command.type === "worktree.create") {
              assert.match(
                command.worktreeId,
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
              );
              aliases.set(command.worktreeId, `<created:${++createSequence}>`);
              if (response.status === 200)
                assert.equal(body.worktreeId, command.worktreeId);
              if (body.mutation?.target)
                assert.equal(
                  body.mutation.target.worktreeId,
                  command.worktreeId,
                );
            }
          const [rows] = await h.fixture.sql(
            [],
            [
              `SELECT jsonb_build_object('trees',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'source',w.project_source_id,'worker',w.worker_id,'name',w.name,'path',w.absolute_path,'primary',w.is_primary,'origin',w.origin,'state',w.lifecycle_state,'branch',w.branch,'head',w.head,'locked',w.locked) ORDER BY w.id),'[]'::jsonb) FROM project_worktrees w JOIN project_sources s ON s.id=w.project_source_id WHERE s.project_id=${literal(project)}),'lanes',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM chat_execution_lanes l WHERE l.chat_id=${literal(chat)}),'runtimes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM chat_runtime_sessions r WHERE r.chat_id=${literal(chat)}))::text AS result`,
            ],
          );
          for (const lane of rows.lanes)
            if (lane.id !== "mcp-worktree-lane") {
              assert.match(lane.id, /^[0-9a-f-]{36}$/);
              aliases.set(lane.id, `<lane:${normalize(lane.worktree_id)}>`);
              if (lane.runtime_session_id !== "settings-runtime")
                aliases.set(
                  lane.runtime_session_id,
                  `<runtime:${normalize(lane.worktree_id)}>`,
                );
            }
          const record = result.calls.at(-1);
          record.comparison = normalize(
            typeof args.purpose === "string" && args.purpose.includes("\u0000")
              ? verifyTransitionQueryError({ body, args, rows, began })
              : body,
          );
          record.commandComparison = normalize(commands);
          const snapshot = normalize(rows);
          for (const key of ["trees", "lanes", "runtimes"])
            snapshot[key].sort((a, b) => a.id.localeCompare(b.id));
          result.snapshots.push({ name, rows: snapshot });
          return body;
        };
        const taskSnapshot = await captureTaskRuntimeState({
          ownerId: h.owner,
          projectId: project,
          query: (statements, queries) => h.fixture.sql(statements, queries),
        });
        assert.equal(Object.keys(taskSnapshot.rows).length, 8);
        assert.ok(
          taskSnapshot.rows.chat_runtime_sessions.some(
            (row) => row.id === "settings-runtime",
          ),
        );
        result.liveTaskSnapshotProtocolProof = {
          eightTablesCaptured: true,
          existingRuntimeRetained: true,
        };
        assert.equal(
          (await call("initial list", "list")).data.worktrees.length,
          3,
        );
        await call("paged list", "list", { cursor: 0, limit: 1 });
        await call("null paging defaults", "list", {
          cursor: null,
          limit: null,
        });
        await call("lease history", "list", { includeLeaseHistory: true });
        await worktreeReadBoundaries({ h, state, binding, call, result });
        for (const args of [
          { cursor: -1 },
          { cursor: 2000 },
          { cursor: "0" },
          { limit: 0 },
          { limit: 201 },
          { limit: 1.5 },
        ])
          await call("invalid list " + JSON.stringify(args), "list", args, 400);
        await call("current status", "status");
        await call("bounded status", "status", {
          worktreeId: agentTree,
          fileLimit: 1,
          branchLimit: 1,
        });
        await call("targeted status", "status", {
          target: {
            kind: "worktree",
            projectId: project,
            worktreeId: agentTree,
          },
        });
        await call(
          "nonworktree status",
          "status",
          { target: { kind: "project", projectId: project } },
          400,
        );
        await call(
          "wrong project status",
          "status",
          {
            target: {
              kind: "worktree",
              projectId: "other-project",
              worktreeId: agentTree,
            },
          },
          409,
        );
        state.mode = "wrong-path";
        await call("wrong worker path", "status", {}, 400);
        state.mode = null;
        state.mode = "invalid-status";
        await call("invalid worker result", "status", {}, 400);
        state.mode = null;
        await call(
          "invalid file bound after dispatch",
          "status",
          { fileLimit: 0 },
          400,
        );
        await call(
          "invalid branch bound after dispatch",
          "status",
          { branchLimit: 501 },
          400,
        );
        for (const args of [
          {},
          { name: "A" },
          { name: "A", intent: "other" },
          { name: "A", intent: "newBranch" },
          { name: "A", intent: "detached" },
          { name: "A", intent: "existingBranch", branch: 1 },
          { name: "A", intent: "detached", baseRevision: 1 },
        ])
          await call(
            "invalid create " + JSON.stringify(args),
            "create",
            args,
            400,
          );
        await worktreeRemovalBoundaries({ h, state, call });
        await worktreeDisconnectCase({
          h,
          state,
          binding,
          call,
          result,
          normalize,
        });
        const created = await call("create agent", "create", {
          name: "  Agent branch  ",
          intent: "newBranch",
          branch: "  feature-new  ",
          baseRevision: " HEAD ",
        });
        assert.equal(created.data.origin, "agent");
        assert.equal(created.data.name, "Agent branch");
        assert.equal(created.data.branch, "feature-new");
        await call("remove new agent", "remove", {
          worktreeId: created.worktreeId,
        });
        await call(
          "primary remove denied",
          "remove",
          { worktreeId: tree },
          400,
        );
        await call(
          "user root removal denied",
          "remove",
          { worktreeId: userTree },
          400,
        );
        await call(
          "primary release denied",
          "release",
          { purpose: "release" },
          400,
        );
        state.mode = "create-failure";
        await call(
          "uncertain worker create",
          "create",
          { name: "Uncertain", intent: "detached", baseRevision: "HEAD" },
          409,
        );
        state.mode = null;
        await call(
          "legacy acquire is not an MCP operation",
          "acquire",
          {
            name: "Continuation",
            intent: "existingBranch",
            branch: "continuation",
            purpose: "  Continue in isolated root  ",
          },
          403,
        );
        const switched = await call("switch to agent", "switch", {
          worktreeId: agentTree,
          purpose: "Switch qualification",
        });
        assert.equal(switched.continuationScheduled, true);
        assert.equal(switched.data.lane.state, "delivering");
        const snapshot = result.snapshots.at(-1).rows;
        assert.ok(
          snapshot.lanes.some(
            (l) => l.worktree_id === agentTree && l.state === "delivering",
          ),
        );
        for (const purpose of [
          "bad\u0000purpose",
          "\ud800\u0000purpose,🚀",
          "\ufffd\u0000purpose,🚀",
        ]) {
          await call(
            "NUL purpose rolls back a pending transition " +
              JSON.stringify(purpose),
            "switch",
            { worktreeId: agentTree, purpose },
            400,
          );
          assert.deepEqual(
            result.snapshots.at(-1).rows,
            snapshot,
            "A failed real SQL write must roll back the preceding lane suspension",
          );
        }
        await call(
          "pending lease blocks removal",
          "remove",
          { worktreeId: agentTree },
          400,
        );
        // Set up the next active context independently of native turn execution.
        // The MCP call above is required to have durably scheduled its real lane.
        await h.fixture.sql([
          `UPDATE chat_execution_lanes SET state='suspended',transition_kind=NULL WHERE id='mcp-worktree-lane'`,
          `UPDATE chat_execution_lanes SET state='active',transition_kind=NULL,activated_at=now() WHERE id=${literal(switched.data.lane.id)}`,
          `UPDATE chats SET active_worktree_id=${literal(agentTree)} WHERE id=${literal(chat)}`,
        ]);
        binding.worktreeId = agentTree;
        binding.executionLaneId = switched.data.lane.id;
        await call(
          "current agent root cannot be removed",
          "remove",
          { worktreeId: agentTree },
          400,
        );
        await call(
          "switch current root conflicts",
          "switch",
          { worktreeId: agentTree, purpose: "Already current" },
          409,
        );
        state.files = [
          {
            path: "changed.txt",
            originalPath: null,
            indexStatus: " ",
            worktreeStatus: "M",
            staged: false,
            unstaged: true,
          },
        ];
        await call(
          "dirty release rejected",
          "release",
          { purpose: "Release qualification" },
          400,
        );
        state.files = [];
        const released = await call("schedule clean release", "release", {
          purpose: "Release qualification",
        });
        assert.equal(released.worktreeId, tree);
        assert.equal(released.continuationScheduled, true);
        assert.equal(released.data.lane.state, "delivering");
        await h.fixture.sql([
          `UPDATE project_branch_leases SET state='released',released_at=now(),updated_at=now() WHERE project_id=${literal(project)}`,
          `UPDATE chat_execution_lanes SET state='released',transition_kind=NULL,released_at=now() WHERE chat_id=${literal(chat)} AND id<>'mcp-worktree-lane'`,
          `UPDATE chat_execution_lanes SET state='active',transition_kind=NULL,released_at=NULL WHERE id='mcp-worktree-lane'`,
          `UPDATE chats SET active_worktree_id=${literal(tree)} WHERE id=${literal(chat)}`,
        ]);
        binding.worktreeId = tree;
        binding.executionLaneId = "mcp-worktree-lane";
        const scope = { ...binding, permissionProfileId: ":read-only" };
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await call("read only list", "list", {}, 200, scope);
        await call(
          "read only create forbidden",
          "create",
          { name: "No", intent: "newBranch", branch: "no" },
          403,
          scope,
        );
        await call("read only status", "status", {}, 200, scope);
        for (const action of ["switch", "release", "remove"])
          await call(
            "read only " + action + " forbidden",
            action,
            {},
            403,
            scope,
          );
        await worktreeFinalBoundaries({ h, call, binding, result });
        result.commands = state.commands;
        result.housekeeping = state.housekeeping;
      } finally {
        result.serverDiagnostics = h.fixture.server?.diagnostics();
        await h.close();
        h = undefined;
      }
    }
    if (peers.length === 2) {
      assert.deepEqual(
        p.peers[1].calls.map((c) => ({
          name: c.name,
          status: c.status,
          body: c.comparison,
          commands: c.commandComparison,
        })),
        p.peers[0].calls.map((c) => ({
          name: c.name,
          status: c.status,
          body: c.comparison,
          commands: c.commandComparison,
        })),
      );
      assert.deepEqual(p.peers[1].snapshots, p.peers[0].snapshots);
      assert.deepEqual(p.peers[1].auditEvents, p.peers[0].auditEvents);
      assert.deepEqual(p.peers[1].capabilityProof, p.peers[0].capabilityProof);
      assert.deepEqual(
        p.peers[1].disconnections.map((c) => c.comparison),
        p.peers[0].disconnections.map((c) => c.comparison),
      );
    }
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close().catch((error) => {
    report.cleanupFailure = { message: error.message };
    failure ??= error;
  });
  await postgres?.close();
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      reportPath,
      root,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        peers: p.peers.map((r) => ({ kind: r.kind, calls: r.calls.length })),
      })),
      ...(failure ? { failure: report.failure } : {}),
    }),
  );
}
if (failure) throw failure;
