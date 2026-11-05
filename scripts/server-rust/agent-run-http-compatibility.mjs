// Real authenticated MCP, WorkerConnection, native Run services and SQL state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
import {
  runRestartCases,
  runStandaloneCases,
  runTextCases,
  verifyRunQueryError,
} from "./agent-run-http-boundaries.mjs";
import { runWorkerBindingCases } from "./agent-run-worker-binding-cases.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  configurationId,
  privateRunMarker,
  operations,
  mutations,
  runWorker,
} from "./agent-run-http-fixtures.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-run-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-run-"));
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
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
    (v) => !option("--profile") || v === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of peers) {
      const result = {
        kind,
        observations: [],
        commands: [],
        calls: [],
        snapshots: [],
      };
      p.peers.push(result);
      const state = runWorker();
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
      try {
        await h.fixture.sql([
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-run-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        await h.live.subscribed("mcp-runs", [
          { kind: "project", projectId: project },
        ]);
        const binding = {
          bindingId: "eeeeeeee-eeee-4eee-8eee-000000000700",
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-run-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: operations,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        const aliases = new Map();
        let sequence = 0;
        const id = () =>
          `dddddddd-dddd-4ddd-8ddd-${String(++sequence).padStart(12, "0")}`;
        const began = Date.now();
        const normalize = (value, key) => {
          if (typeof value === "string") {
            if (aliases.has(value)) return aliases.get(value);
            if (["createdAt", "updatedAt"].includes(key)) {
              assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
              assert.ok(
                Date.parse(value) >= began - 1000 &&
                  Date.parse(value) <= Date.now() + 1000,
                "actual generated clock is bounded",
              );
              return "<verified generated clock>";
            }
          }
          if (Array.isArray(value)) return value.map((v) => normalize(v, key));
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([k, v]) => [
                k,
                k === "protectedValue"
                  ? "<worker-verified secret ciphertext>"
                  : normalize(v, k),
              ]),
            );
          return value;
        };
        const call = async (
          name,
          action,
          args = {},
          status = 200,
          claims = binding,
        ) => {
          const operation = action.startsWith("run-configuration.")
            ? action
            : "run-configuration." + action;
          const commandStart = state.commands.length;
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
          const record = {
            name,
            operation,
            args,
            status: response.status,
            body,
            httpRequestId: response.headers.get("x-request-id"),
          };
          result.calls.push(record);
          assert.equal(
            response.status,
            status,
            JSON.stringify({ kind, name, body }),
          );
          const [rows] = await h.fixture.sql(
            [],
            [
              `SELECT coalesce(jsonb_agg(jsonb_build_object('runtime',to_jsonb(r),'terminal',to_jsonb(t)) ORDER BY r.configuration_id,r.worktree_id),'[]'::jsonb)::text result FROM run_configuration_runtimes r LEFT JOIN terminals t ON t.id=r.terminal_id WHERE r.owner_id=${literal(h.owner)}`,
            ],
          );
          for (const { runtime: r, terminal: t } of rows) {
            assert.match(r.id, uuid);
            aliases.set(
              r.id,
              `<runtime:${r.configuration_id}:${r.worktree_id}>`,
            );
            if (r.terminal_id) {
              assert.equal(t.id, r.terminal_id);
              assert.equal(t.project_id, r.project_id);
              aliases.set(
                t.id,
                `<terminal:${r.configuration_id}:${r.worktree_id}>`,
              );
            }
          }
          const generated =
            operation.endsWith(".list") ||
            operation.endsWith(".get") ||
            operation.endsWith(".detect") ||
            operation.endsWith(".status");
          if (generated && body.data?.operationId) {
            assert.match(body.data.operationId, uuid);
            aliases.set(body.data.operationId, `<generated operation:${name}>`);
          }
          const commands = state.commands.slice(commandStart);
          for (const [index, command] of commands.entries()) {
            if (
              command.operationId &&
              command.operationId !== args.operationId &&
              !aliases.has(command.operationId)
            ) {
              assert.match(command.operationId, uuid);
              aliases.set(
                command.operationId,
                `<internal operation:${name}:${index}>`,
              );
            }
            if (command.serverId) {
              assert.equal(command.serverId, h.serverId);
              aliases.set(command.serverId, "<verified server identity>");
            }
          }
          let comparison = structuredClone(body);
          if (body.error?.startsWith("Failed query: "))
            comparison.error = verifyRunQueryError({
              body,
              args,
              owner: h.owner,
              project,
            });
          if (body.data?.protectedOutput) {
            await state.verifyOutput(body.data);
            comparison.data.protectedOutput =
              "<verified endpoint output ciphertext>";
          }
          record.comparison = normalize(comparison);
          record.commands = normalize(commands);
          result.snapshots.push({ name, rows });
          return body;
        };
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
        for (const operation of operations)
          assert.ok(result.capabilities.operations.includes(operation));
        await call("empty catalog", "list");
        await call("missing definition", "get", { configurationId }, 404);
        await call("empty detection", "detect");
        for (const [action, args] of [
          ["list", { unknown: true }],
          ["get", {}],
          ["get", { configurationId: "invalid" }],
          ["detect", { provider: null }],
          ["status", { limit: 0 }],
          ["read-output", { operationId: id(), configurationId, tail: 0 }],
        ])
          await call(
            "invalid " + action + " " + JSON.stringify(args),
            action,
            args,
            400,
          );
        const create = { operationId: id(), document: state.document };
        assert.equal(
          (await call("create definition", "create", create)).mutated,
          true,
        );
        await call("read definition", "get", { configurationId });
        await call("list definition", "list");
        await call("detection provider", "detect", { provider: "shell" });
        await call(
          "create existing rejected",
          "create",
          { ...create, operationId: id() },
          409,
        );
        await call(
          "update identity mismatch",
          "update",
          {
            operationId: id(),
            configurationId: "eeeeeeee-eeee-4eee-8eee-000000000702",
            expectedRevision: "a".repeat(64),
            document: state.document,
          },
          400,
        );
        await call(
          "update wrong revision",
          "update",
          {
            operationId: id(),
            configurationId,
            expectedRevision: "f".repeat(64),
            document: state.document,
          },
          409,
        );
        await call("update definition", "update", {
          operationId: id(),
          configurationId,
          expectedRevision: "a".repeat(64),
          document: state.document,
        });
        const protectedValue = await state.seal(project);
        const secret = {
          operationId: id(),
          reference: "run/api",
          protectedValue,
        };
        assert.equal(
          (await call("store encrypted secret", "secret-set", secret)).mutated,
          true,
        );
        assert.equal(
          (await call("immutable secret replay", "secret-set", secret)).mutated,
          false,
        );
        await call(
          "secret conflict",
          "secret-set",
          { ...secret, reference: "run/other" },
          400,
        );
        await call("read secret availability", "get", { configurationId });
        const start = { operationId: id(), configurationId };
        const started = await call("start runtime", "start", start);
        assert.equal(started.data.runtime.state, "running");
        const count = state.commands.length;
        assert.equal(
          (await call("replay start", "start", start)).data.replayed,
          true,
        );
        assert.equal(state.commands.length, count);
        await call("conflicting replay", "stop", start, 409);
        assert.equal(
          (
            await call("already active", "start", {
              ...start,
              operationId: id(),
            })
          ).mutated,
          false,
        );
        await call("runtime status", "status");
        await call("runtime target status", "status", {
          configurationId,
          worktreeId: tree,
          limit: 1,
        });
        await call("read encrypted output", "read-output", {
          operationId: id(),
          configurationId,
          worktreeId: tree,
        });
        state.mode = "output-misrouted";
        await call(
          "misrouted output",
          "read-output",
          { operationId: id(), configurationId },
          400,
        );
        state.mode = null;
        state.mode = "output-malformed";
        await call(
          "malformed output",
          "read-output",
          { operationId: id(), configurationId },
          400,
        );
        state.mode = null;
        await call("restart runtime", "restart", {
          operationId: id(),
          configurationId,
          worktreeId: tree,
        });
        await call("stable replay after restart", "start", start);
        await call("stop runtime", "stop", {
          operationId: id(),
          configurationId,
        });
        assert.equal(
          (
            await call("already inactive", "stop", {
              operationId: id(),
              configurationId,
            })
          ).mutated,
          false,
        );
        for (const action of ["list", "get", "detect"]) {
          const args = action === "get" ? { configurationId } : {};
          state.definitions.mode = "misrouted";
          await call("misrouted definition " + action, action, args, 400);
          state.definitions.mode = "malformed";
          await call("malformed definition " + action, action, args, 400);
          state.definitions.mode = null;
        }
        state.mode = "runtime-not-found";
        await call(
          "worker lost runtime",
          "start",
          { operationId: id(), configurationId },
          409,
        );
        state.mode = "runtime-malformed";
        await call(
          "worker malformed runtime reply",
          "start",
          { operationId: id(), configurationId },
          400,
        );
        state.mode = null;
        await call("runtime recovers after failed dispatch", "start", {
          operationId: id(),
          configurationId,
        });
        await call("recovered runtime stops", "stop", {
          operationId: id(),
          configurationId,
        });
        await runWorkerBindingCases({
          h,
          state,
          call,
          id,
          configurationId,
          root,
          profile,
          kind,
        });
        result.workerBindingProofs = state.workerBindingProofs;
        await runTextCases({ call, state, id, configurationId });
        await call("safe reader follows current lane", "list", {}, 200, {
          ...binding,
          executionLaneId: "stale",
          worktreeId: "stale",
          permissionProfileId: ":read-only",
        });
        await call("mutation requires exact lane", "create", create, 409, {
          ...binding,
          executionLaneId: "stale",
        });
        await call("missing grant", "list", {}, 403, {
          ...binding,
          allowedOperations: ["context.get"],
        });
        await call("foreign binding owner", "list", {}, 403, {
          ...binding,
          ownerId: "foreign",
        });
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await call("read-only list", "list");
        for (const action of [
          "create",
          "update",
          "delete",
          "start",
          "restart",
          "stop",
          "secret-set",
        ])
          await call("read-only denies " + action, action, {}, 403, {
            ...binding,
            permissionProfileId: ":read-only",
          });
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
        ]);
        await runRestartCases({
          h,
          call,
          binding,
          state,
          start,
          secret,
          configurationId,
          id,
        });
        result.actualServerRestartVerified = true;
        await call(
          "delete stale revision",
          "delete",
          {
            operationId: id(),
            configurationId,
            expectedRevision: "a".repeat(64),
          },
          409,
        );
        await call("delete definition", "delete", {
          operationId: id(),
          configurationId,
          expectedRevision: "b".repeat(64),
        });
        await call(
          "delete missing",
          "delete",
          {
            operationId: id(),
            configurationId,
            expectedRevision: "b".repeat(64),
          },
          404,
        );
        await call(
          "missing output",
          "read-output",
          {
            operationId: id(),
            configurationId: "eeeeeeee-eeee-4eee-8eee-000000000702",
          },
          404,
        );
        await h.fixture.sql([
          `UPDATE chats SET status='idle' WHERE id=${literal(chat)}`,
        ]);
        await call("inactive chat", "list", {}, 409);
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        await runStandaloneCases({ h, call, binding, operations });
        assert.ok(state.secretProofs >= 2);
        assert.equal(state.outputProofs, 2);
        result.secretProofs = state.secretProofs;
        result.outputProofs = state.outputProofs;
        const [audit] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb))::text result FROM audit_events a WHERE a.action LIKE 'mcp.operation.%' OR a.action LIKE 'run-configuration.mcp.%'",
          ],
        );
        assert.equal(audit.events.length, result.calls.length);
        const calls = new Map(result.calls.map((c) => [c.httpRequestId, c]));
        result.auditEvents = audit.events.map((event) => {
          const call = calls.get(event.request_id);
          assert.ok(call);
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          const lifecycle = ["start", "restart", "stop"].some(
            (action) => call.operation === "run-configuration." + action,
          );
          assert.equal(
            event.resource_type,
            call.status === 200 && lifecycle
              ? "run-configuration"
              : "mcp-binding",
          );
          assert.equal(
            event.resource_id,
            call.status === 200 && lifecycle
              ? configurationId
              : binding.bindingId,
          );
          const special = {
            "run-configuration.start": "run-configuration.mcp.started",
            "run-configuration.restart": "run-configuration.mcp.restarted",
            "run-configuration.stop": "run-configuration.mcp.stopped",
            "run-configuration.delete": "run-configuration.mcp.deleted",
          };
          const action =
            call.status === 200
              ? (special[call.operation] ??
                (mutations.has(call.operation)
                  ? "mcp.operation.mutated"
                  : "mcp.operation.executed"))
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
        result.backgroundEmptyRuntimeReconciliations =
          state.emptyRuntimeReconciliations;
        result.diagnostics = h.diagnostics();
        assert.equal(
          JSON.stringify(result.diagnostics).includes(privateRunMarker),
          false,
        );
        await h.close();
        h = undefined;
      }
    }
    if (p.peers.length === 2) {
      const compact = (peer) =>
        peer.calls.map(({ name, status, comparison, commands }) => ({
          name,
          status,
          body: comparison,
          commands,
        }));
      const expected = compact(p.peers[0]),
        actual = compact(p.peers[1]);
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < expected.length; i++)
        assert.deepEqual(
          actual[i],
          expected[i],
          "Rust Run MCP matches Source: " + expected[i].name,
        );
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
