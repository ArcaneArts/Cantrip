// Actual worker WebSocket notifications, production callbacks, SQL and App Live.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import {
  appLiveEventPayloadSchema,
  worktreeStatusResultSchema,
} from "../../packages/protocol/dist/index.js";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  settingsHttpFixture,
  settingsProject as project,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
    "initial-only": { type: "boolean", default: false },
    production: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worktree-status-"));
const sourcePath = "ctrr_" + "s".repeat(43),
  worktreePath = "ctrr_" + "w".repeat(43);
const report = {
  suite: "worktree-status-worker-http",
  root,
  databaseMode: values.database,
  completeReplacement: false,
  productionRuntime: values.production,
  actualWorkerControlConnection: true,
  fullWorkerProcess: false,
  usesSqlHttpFixture: !values.production,
  profiles: [],
  cleanupFailures: [],
};
let pg, failure, h, databaseClient;
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const sql = `SELECT jsonb_build_object('branch',branch,'head',head,'detached',detached,'lifecycle',lifecycle_state,'locked',locked,'lockReason',lock_reason,'snapshot',status_snapshot,'updated',floor(extract(epoch from updated_at)*1000),'scanned',floor(extract(epoch from last_scanned_at)*1000),'observed',floor(extract(epoch from status_observed_at)*1000),'created',created_at)::text result FROM project_worktrees WHERE id=${literal(tree)}`;
const status = (changes = {}) =>
  worktreeStatusResultSchema.parse({
    worktree: {
      path: worktreePath,
      head: "a".repeat(40),
      branch: "observed-main",
      detached: false,
      isPrimary: true,
      managed: true,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
      ...changes,
    },
    status: {
      branch: "observed-main",
      head: "a".repeat(40),
      upstream: null,
      ahead: 1,
      behind: 0,
      files: [],
      branches: [],
    },
  });
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !values.profile || p === values.profile,
  )) {
    const peers = [];
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const current = {
        kind,
        observations: [],
        actions: [],
        commands: [],
        sentNotifications: [],
        failures: [],
      };
      peers.push(current);
      const databaseUrl =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode: values.database,
        passwordHash,
        result: current,
        liveSqlFixture: !values.production,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        url: databaseUrl,
        configure: () => [
          `UPDATE project_sources SET absolute_path=${literal(sourcePath)},display_path=${literal(sourcePath)} WHERE id='settings-source'`,
          `UPDATE project_worktrees SET absolute_path=${literal(worktreePath)},display_path=${literal(worktreePath)},created_at=${literal(stamp)},updated_at=${literal(stamp)},last_scanned_at=NULL,status_observed_at=NULL WHERE id=${literal(tree)}`,
        ],
        onCommand: async (command) => {
          if (command.type === "worktree.observation.configure") {
            current.commands.push(command);
            return { accepted: true, paths: [] };
          }
        },
      });
      const server = h.fixture.server;
      const retainedFixture = h.fixture;
      if (values.production)
        databaseClient = require("postgres")(databaseUrl, { max: 1 });
      const executeSql = async (statements = [], queries = []) => {
        if (!databaseClient) return retainedFixture.sql(statements, queries);
        for (const statement of statements)
          await databaseClient.unsafe(statement);
        const results = [];
        for (const query of queries) {
          const rows = await databaseClient.unsafe(query);
          results.push(rows[0] ? JSON.parse(rows[0].result) : null);
        }
        return results;
      };
      try {
        if (values.production) {
          const absent = await retainedFixture.observe(
            "SQL test route absent",
            "POST",
            "/__fixture/sql",
            { csrf: true, json: { statements: [], queries: [] }, status: 404 },
          );
          current.observations.push(absent);
        }
        await h.live.subscribed("worktree-status-contract", [
          { kind: "project", projectId: project },
        ]);
        const read = async () => (await executeSql([], [sql]))[0];
        const events = (from) =>
          h.live.history
            .slice(from)
            .filter(
              (e) =>
                e.type === "event" &&
                ["worktree-status", "worktree"].includes(e.resource),
            )
            .map(
              ({ scope, resource, action, entityId, revision, payload }) => ({
                scope,
                resource,
                action,
                entityId,
                revision,
                payload,
              }),
            );
        const send = async (
          name,
          result,
          changes = {},
          expectedEvents = null,
          shouldApply = true,
        ) => {
          const before = await read(),
            start = Date.now(),
            from = h.live.history.length;
          const notification = {
            type: "worktree.status.observed",
            projectId: project,
            worktreeId: tree,
            sourcePath,
            worktreePath,
            result,
            ...changes,
          };
          assert.equal(h.worker.sendNotification(notification), true);
          current.sentNotifications.push(notification);
          const action = { name, notification, before };
          current.actions.push(action);
          if (shouldApply)
            await eventually(read, (row) => {
              action.after = row;
              assert.deepEqual(row.snapshot, result);
              assert.equal(row.branch, result.worktree.branch);
            });
          // A following valid changed observation gives rejected notifications
          // an actual processing boundary on the same worker socket.
          if (!shouldApply) {
            const marker = status({
              branch: "barrier-" + current.actions.length,
            });
            assert.equal(
              h.worker.sendNotification({
                type: "worktree.status.observed",
                projectId: project,
                worktreeId: tree,
                sourcePath,
                worktreePath,
                result: marker,
              }),
              true,
            );
            current.sentNotifications.push({
              type: "worktree.status.observed",
              projectId: project,
              worktreeId: tree,
              sourcePath,
              worktreePath,
              result: marker,
            });
            await eventually(read, (row) => {
              action.after = row;
              assert.deepEqual(row.snapshot, marker);
            });
            await eventually(
              () => events(from),
              (e) =>
                assert.ok(
                  e.some(
                    (x) =>
                      x.resource === "worktree-status" &&
                      x.payload.branch === marker.status.branch,
                  ),
                ),
            );
            assert.ok(
              !events(from).some(
                (x) =>
                  x.resource === "worktree-status" &&
                  x.payload.head === result.status.head,
              ),
            );
          } else if (expectedEvents)
            await eventually(
              () => events(from),
              (e) =>
                assert.deepEqual(
                  e.map((x) => x.resource),
                  expectedEvents,
                ),
            );
          await h.live.ping(name);
          action.events = events(from);
          action.clockWindow = [start, Date.now()];
          // Re-read after the actual publication boundary. A replay's identical
          // snapshot can be visible before its new write has committed.
          action.after = await read();
          for (const key of ["updated", "scanned", "observed"])
            assert.ok(
              action.after[key] >= start &&
                action.after[key] <= action.clockWindow[1],
              name + " actual persistence clock",
            );
          for (const event of action.events) {
            assert.deepEqual(event.scope, {
              kind: "project",
              projectId: project,
            });
            assert.equal(event.entityId, tree);
          }
          action.comparison = {
            name,
            state: {
              ...action.after,
              updated: "<verified write time>",
              scanned: "<verified write time>",
              observed: "<verified write time>",
            },
            events: action.events,
          };
          return action;
        };
        const first = await send(
          "owned notification persists metadata and exact status",
          status(),
          {},
          ["worktree-status", "worktree"],
        );
        assert.deepEqual(first.events[0].payload, status().status);
        assert.equal(first.events[1].payload, null);
        if (!values["initial-only"]) {
          await send(
            "same snapshot follows actual reference replay behavior",
            status(),
            {},
            ["worktree-status"],
          );
          const changed = status({
            head: "b".repeat(40),
            locked: true,
            lockReason: "observed lock",
          });
          changed.status = {
            ...changed.status,
            head: "b".repeat(40),
            ahead: 2,
          };
          await send("changed locked metadata and status", changed, {}, [
            "worktree-status",
            "worktree",
          ]);
          // Public IDs are hints: actual ownership and routing come from the
          // authenticated worker and its stored source/worktree paths.
          await send(
            "stored paths determine scope despite unrelated notification IDs",
            status({ branch: "resolved-owned" }),
            {
              projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              worktreeId: "missing",
            },
            ["worktree-status", "worktree"],
          );
          for (const [name, changes, result] of [
            [
              "unknown source path is ignored",
              { sourcePath: "ctrr_" + "x".repeat(43) },
              status({ head: "c".repeat(40) }),
            ],
            [
              "mismatched result path is ignored",
              {},
              status({ path: "ctrr_" + "x".repeat(43), head: "d".repeat(40) }),
            ],
          ]) {
            result.status = { ...result.status, head: result.worktree.head };
            await send(name, result, changes, null, false);
          }
          const rejectedBefore = await read(),
            rejectionAt = h.live.history.length;
          const previousWarnings = server
            .diagnostics()
            .split("Could not apply worker notification").length;
          await executeSql([
            "ALTER TABLE project_worktrees ADD CONSTRAINT worktree_status_fixture_rejection CHECK (branch IS DISTINCT FROM 'reject-worktree-status') NOT VALID",
          ]);
          const rejected = {
            type: "worktree.status.observed",
            projectId: project,
            worktreeId: tree,
            sourcePath,
            worktreePath,
            result: status({ branch: "reject-worktree-status" }),
          };
          assert.equal(h.worker.sendNotification(rejected), true);
          current.sentNotifications.push(rejected);
          await eventually(
            () => server.diagnostics(),
            (text) =>
              assert.ok(
                text.split("Could not apply worker notification").length >
                  previousWarnings,
              ),
          );
          const rejectedAfter = await read();
          assert.deepEqual(
            rejectedAfter,
            rejectedBefore,
            "Actual rejected SQL mutation retains every stored field and clock",
          );
          await h.live.ping("rejected SQL notification settled");
          assert.deepEqual(
            events(rejectionAt),
            [],
            "Rejected SQL write publishes no success event",
          );
          current.failures.push({
            name: "actual SQL write rejection",
            before: rejectedBefore,
            after: rejectedAfter,
            events: events(rejectionAt),
          });
          await executeSql([
            "ALTER TABLE project_worktrees DROP CONSTRAINT worktree_status_fixture_rejection",
          ]);
          await send(
            "normal notification recovers after SQL rejection",
            status({ branch: "after-query-failure" }),
            {},
            ["worktree-status", "worktree"],
          );
          const oversized = status({ branch: "oversized-live-payload" });
          oversized.status.files = [
            {
              path: "PRIVATE_STATUS_BOUNDARY_" + "x".repeat(300001),
              originalPath: null,
              indexStatus: " ",
              worktreeStatus: "M",
              staged: false,
              unstaged: true,
            },
          ];
          worktreeStatusResultSchema.parse(oversized);
          assert.equal(
            appLiveEventPayloadSchema.safeParse(oversized.status).success,
            false,
          );
          await send(
            "Live payload rejection retains the committed status and metadata invalidation",
            oversized,
            {},
            ["worktree"],
          );
          await eventually(
            () => server.diagnostics(),
            (text) =>
              assert.ok(text.includes("Could not publish worktree status")),
          );
          assert.equal(
            server.diagnostics().includes("PRIVATE_STATUS_BOUNDARY_"),
            false,
            "Publication validation diagnostics exclude file content",
          );
          for (const [name, fields, expected] of [
            ["prunable observation", { prunable: true }, "prunable"],
            [
              "missing takes precedence over prunable",
              { missing: true, prunable: true },
              "missing",
            ],
          ]) {
            await executeSql([
              `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${literal(tree)}`,
            ]);
            const action = await send(name, status(fields), {}, [
              "worktree-status",
              "worktree",
            ]);
            assert.equal(action.after.lifecycle, expected);
          }
        }
        current.retained = await read();
        current.diagnostics = server.diagnostics();
        current.passed = true;
      } finally {
        current.diagnostics = server.diagnostics();
        await h.close();
        current.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
        h = null;
      }
      assert.deepEqual(current.exit, { code: 0, signal: null });
      if (current.passed && !values["initial-only"]) {
        await retainedFixture.start();
        const restarted = retainedFixture.server;
        current.restart = {};
        try {
          current.restart.state = (await executeSql([], [sql]))[0];
          assert.deepEqual(
            current.restart.state,
            current.retained,
            "Actual server restart retains worktree state and every clock",
          );
        } finally {
          await retainedFixture.close();
          current.restart.exit = {
            code: restarted.child.exitCode,
            signal: restarted.child.signalCode,
          };
        }
        assert.deepEqual(current.restart.exit, { code: 0, signal: null });
      }
      await databaseClient?.end({ timeout: 5 });
      databaseClient = null;
    }
    assert.deepEqual(
      peers[1].actions.map((x) => x.comparison),
      peers[0].actions.map((x) => x.comparison),
    );
    assert.deepEqual(peers[1].observations, peers[0].observations);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const close of [
    () => h?.close(),
    () => databaseClient?.end({ timeout: 5 }),
    () => pg?.close(),
  ])
    try {
      await close();
    } catch (error) {
      failure ??= error;
      report.cleanupFailures.push(error.stack);
    }
  if (failure) report.passed = false;
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !values["keep-fixture"])
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    database: values.database,
    profiles: report.profiles.length,
    pairedNotifications: report.profiles.reduce(
      (n, p) => n + p.peers[0].sentNotifications.length,
      0,
    ),
  }),
);
