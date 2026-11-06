// Both production HTTP implementations and the unchanged worker CLI client.
// WorkerConnection is real; endpoint/Git/Run replies are controlled fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { invokeCantripCliCommand } from "../../cantrip_worker/src/cli-client.ts";
import { buildRustExample } from "./build.mjs";
import { cliHttpCases } from "./cli-http-cases.mjs";
import { cliWorkerHeartbeat } from "./cli-worker-heartbeat.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  surfaceSeed,
  surfaceWorker,
  lane,
} from "./agent-surface-http-fixtures.mjs";
import {
  worktreeWorker,
  agentTree,
  userTree,
  managedRoot,
} from "./agent-worktree-http-fixtures.mjs";
import { seedPolicies } from "./agent-policy-http-fixtures.mjs";
import { runWorker } from "./agent-run-http-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath =
  option("--report") ?? `.qa/rust-server/cli-http-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-cli-http-"));
const report = {
  root,
  databaseMode,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  actualHttp: true,
  actualWorkerConnection: true,
  actualWorkerCliClient: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, postgres, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        calls: [],
        comparisons: [],
      };
      p.peers.push(result);
      const surfaces = surfaceWorker(),
        trees = worktreeWorker(),
        runs = runWorker();
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
        onCommand: async (...args) => {
          for (const endpoint of [runs, surfaces, trees]) {
            const response = await endpoint.onCommand(...args);
            if (response !== undefined) return response;
          }
        },
      });
      try {
        await h.fixture.sql([
          ...surfaceSeed(h.owner),
          `UPDATE workers SET display_name='CLI Selector Worker' WHERE id=${literal(worker)}`,
        ]);
        const policies = await seedPolicies(h);
        await h.fixture.sql(
          [
            [agentTree, "Agent", "feature-a", "agent"],
            [userTree, "User", "feature-u", "user"],
          ].map(
            ([id, name, branch, origin]) =>
              `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,head) VALUES(${literal(id)},'settings-source',${literal(worker)},${literal(name)},${literal(managedRoot + "/" + origin)},${literal(managedRoot + "/" + origin)},false,${literal(origin)},'ready',${literal(branch)},${literal("a".repeat(40))})`,
          ),
        );
        await h.live.subscribed("cli", [
          { kind: "project", projectId: project },
        ]);
        const verifiedSecretValues = new Set();
        const began = Date.now(),
          aliases = new Map([
            [h.owner, "<owner>"],
            [h.serverId, "<server>"],
          ]);
        const normalize = (value, key) => {
          if (key === "protectedValue") {
            assert.ok(
              verifiedSecretValues.has(JSON.stringify(value)),
              "opaque secret was produced and verified by the worker endpoint",
            );
            return "<worker verified secret ciphertext>";
          }
          if (typeof value === "string") {
            for (const [id, alias] of aliases)
              value = value.replaceAll(id, alias);
            if (
              /(?:At|_at)$/.test(key ?? "") &&
              Number.isFinite(Date.parse(value)) &&
              Date.parse(value) >= began - 1000
            ) {
              assert.ok(Date.parse(value) <= Date.now() + 1000);
              return "<verified generated clock>";
            }
          }
          if (Array.isArray(value)) return value.map((v) => normalize(v, key));
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
            );
          return value;
        };
        const base = {
          workerId: worker,
          chatContext: { chatId: chat, executionLaneId: lane },
          context: { cwd: null, terminalId: null, codexThreadId: null },
          arguments: {},
        };
        let sequence = 0;
        const id = () =>
          `dddddddd-dddd-4ddd-8ddd-${String(++sequence).padStart(12, "0")}`;
        const auditRows = async () =>
          (
            await h.fixture.sql(
              [],
              [
                "SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text result FROM audit_events a WHERE a.action LIKE 'cli.%' OR a.action LIKE 'run.configuration.cli.%'",
              ],
            )
          )[0];
        const mutationCommands = new Set([
          "worktree.create",
          "worktree.switch",
          "worktree.release",
          "worktree.remove",
          "run.create",
          "run.update",
          "run.delete",
          "run.start",
          "run.restart",
          "run.stop",
          "run.secret-set",
          "explorer.write",
          "terminal.send",
          "terminal.restart",
          "browser.create",
          "browser.open",
        ]);
        async function call(
          name,
          command,
          args = {},
          status = 200,
          overrides = {},
          authorization = h.credential,
        ) {
          await cliWorkerHeartbeat(h, result);
          const requestId = id(),
            before = await auditRows(),
            starts = [
              surfaces.commands.length,
              trees.commands.length,
              runs.commands.length,
            ];
          const input = {
            ...base,
            requestId,
            command,
            arguments: args,
            ...overrides,
          };
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/cli",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + authorization,
                "content-type": "application/json",
              },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(30000),
            },
          );
          const body = await response.json(),
            httpId = response.headers.get("x-request-id");
          const record = { name, input, status: response.status, body, httpId };
          result.calls.push(record);
          assert.equal(
            response.status,
            status,
            JSON.stringify({ kind, ...record }),
          );
          const audits = (await auditRows()).filter(
            (row) => !before.some((old) => old.id === row.id),
          );
          const admitted = status !== 401 && body.error !== "Worker not found.";
          assert.equal(
            audits.length,
            mutationCommands.has(command) && admitted && !body.issues ? 1 : 0,
            name,
          );
          for (const audit of audits) {
            assert.equal(audit.owner_id, h.owner);
            assert.equal(audit.actor_user_id, null);
            assert.equal(audit.actor_session_id, null);
            assert.equal(audit.request_id, httpId);
            assert.ok(Number.isSafeInteger(audit.id) && audit.id > 0);
            const succeeded = response.status === 200;
            const run = command.startsWith("run.");
            const failedAction = [
              "run.start",
              "run.restart",
              "run.stop",
            ].includes(command)
              ? `run.configuration.cli.${command.slice(4)}-failed`
              : run
                ? "run.configuration.cli.mutation-failed"
                : "cli.command.mutated";
            assert.equal(
              audit.action,
              succeeded
                ? run
                  ? `run.configuration.cli.${command.slice(4)}`
                  : "cli.command.mutated"
                : failedAction,
            );
            assert.equal(
              audit.result,
              succeeded
                ? "succeeded"
                : [
                      "conflict",
                      "unsupported-capability",
                      "context-not-found",
                    ].includes(body.code)
                  ? "denied"
                  : "failed",
            );
            assert.equal(
              audit.resource_type,
              succeeded && run ? "run-configuration" : "cli-command",
            );
            assert.equal(
              audit.resource_id,
              succeeded
                ? typeof args.configurationId === "string" &&
                  args.configurationId.trim()
                  ? args.configurationId.trim()
                  : requestId
                : requestId,
            );
          }
          const commands = [
            ...surfaces.commands.slice(starts[0]),
            ...trees.commands.slice(starts[1]),
            ...runs.commands.slice(starts[2]),
          ];
          const [rows] = await h.fixture.sql(
            [],
            [
              `SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'terminalId',r.terminal_id,'configurationId',r.configuration_id,'worktreeId',r.worktree_id) ORDER BY r.configuration_id,r.worktree_id),'[]'::jsonb)::text result FROM run_configuration_runtimes r WHERE r.owner_id=${literal(h.owner)}`,
            ],
          );
          for (const r of rows) {
            assert.match(r.id, /^[0-9a-f-]{36}$/);
            aliases.set(r.id, `<runtime:${r.configurationId}:${r.worktreeId}>`);
            if (r.terminalId)
              aliases.set(
                r.terminalId,
                `<run terminal:${r.configurationId}:${r.worktreeId}>`,
              );
          }
          for (const [index, command] of commands.entries()) {
            if (
              command.operationId &&
              command.operationId !== requestId &&
              !aliases.has(command.operationId)
            ) {
              assert.match(command.operationId, /^[0-9a-f-]{36}$/);
              aliases.set(
                command.operationId,
                `<internal operation:${name}:${index}>`,
              );
            }
          }
          for (const command of commands)
            if (command.type === "worktree.create") {
              assert.match(command.worktreeId, /^[0-9a-f-]{36}$/);
              aliases.set(
                command.worktreeId,
                "<created worktree:" + name + ">",
              );
              if (response.status === 200)
                assert.equal(body.worktreeId, command.worktreeId);
            }
          const [laneRows] = await h.fixture.sql(
            [],
            [
              `SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at,l.id),'[]'::jsonb)::text result FROM chat_execution_lanes l WHERE l.chat_id=${literal(chat)}`,
            ],
          );
          for (const row of laneRows)
            if (row.id !== lane) {
              assert.match(row.id, /^[0-9a-f-]{36}$/);
              aliases.set(row.id, "<lane:" + normalize(row.worktree_id) + ">");
              if (
                row.runtime_session_id &&
                row.runtime_session_id !== "settings-runtime"
              )
                aliases.set(
                  row.runtime_session_id,
                  "<lane runtime:" + normalize(row.worktree_id) + ">",
                );
            }
          if (body.data?.lane)
            assert.ok(
              laneRows.some(
                (row) =>
                  row.id === body.data.lane.id &&
                  row.worktree_id === body.worktreeId,
              ),
              "the returned continuation lane is durable",
            );
          const comparison = command.startsWith("policy.")
            ? policies.comparison(body)
            : structuredClone(body);
          if (body.data?.protectedOutput) {
            await runs.verifyOutput(body.data);
            comparison.data.protectedOutput =
              "<endpoint verified output ciphertext>";
          }
          record.commands = commands;
          record.audits = audits;
          result.comparisons.push(
            normalize({
              name,
              status: response.status,
              body: comparison,
              commands,
              audits: audits.map(({ id, request_id, ...audit }) => audit),
              headers: Object.fromEntries(
                [
                  "content-type",
                  "cache-control",
                  "access-control-allow-origin",
                  "access-control-allow-credentials",
                  "vary",
                  "x-content-type-options",
                  "referrer-policy",
                  "content-security-policy",
                  "cross-origin-resource-policy",
                  "cross-origin-opener-policy",
                  "x-frame-options",
                ].map((key) => [key, response.headers.get(key)]),
              ),
            }),
          );
          return body;
        }
        result.sdk = await invokeCantripCliCommand({
          request: {
            command: "status",
            context: { ...base.context, selection: "auto" },
            arguments: {},
          },
          requestId: id(),
          workerId: worker,
          token: h.credential,
          serverUrl: h.fixture.server.origin,
        });
        assert.equal(result.sdk.data.context, null);
        await cliHttpCases({
          verifiedSecretValues,
          h,
          policies,
          base,
          surfaces,
          runs,
          call,
          id,
          result,
          normalize,
        });
        result.diagnostics = h.diagnostics();
        result.secretProofs = runs.secretProofs;
        result.outputProofs = runs.outputProofs;
      } catch (error) {
        result.diagnostics = h.diagnostics();
        throw error;
      } finally {
        await h.close();
        h = null;
      }
    }
    assert.deepEqual(
      p.peers[1].disconnections.map((v) => v.comparison),
      p.peers[0].disconnections.map((v) => v.comparison),
    );
    assert.deepEqual(p.peers[1].restart, p.peers[0].restart);
    assert.deepEqual(p.peers[1].sdkScenarios, p.peers[0].sdkScenarios);
    assert.deepEqual(
      p.peers[1].comparisons,
      p.peers[0].comparisons,
      profile + " CLI HTTP parity",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (h) await h.close();
  if (postgres) await postgres.close();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    report: reportPath,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      callsPerPeer: p.peers[0].calls.length,
    })),
  }),
);
