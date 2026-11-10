// Real WorkerConnection, durable rows and App Live; inspection replies controlled.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  settingsHttpFixture,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import {
  gitObservationScenarios,
  normalizeGitActions,
} from "./git-observation-scenarios.mjs";
import {
  operationId as id,
  sourcePath,
  worktreePath,
  context,
  completed,
  observation,
} from "./git-observation-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
    "initial-only": { type: "boolean", default: false },
    production: { type: "boolean", default: false },
    "held-shutdown": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-observations-"));
const notification = observation();
const report = {
  suite: "git-operation-worker-observations",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  productionRuntime: values.production,
  actualWorkerControlConnection: true,
  fullWorkerProcess: false,
  usesSqlHttpFixture: !values.production,
  profiles: [],
  cleanupFailures: [],
};
let pg, h, failure, databaseClient;
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
try {
  const executable =
      process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
      (await buildRustExample("http-sql-fixture")),
    repositoryExecutable =
      process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
      (await buildRustExample("project-repository-fixture")),
    passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !values.profile || p === values.profile,
  )) {
    const peers = [];
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], events: [] };
      let inspect = async () => completed;
      peers.push(result);
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
        result,
        liveSqlFixture: !values.production,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        url: databaseUrl,
        configure: (owner) => [
          `UPDATE project_sources SET absolute_path=${literal(sourcePath)},display_path=${literal(sourcePath)} WHERE id='settings-source'`,
          `UPDATE project_worktrees SET absolute_path=${literal(worktreePath)},display_path=${literal(worktreePath)},branch='before',head=${literal(context.originalHead)},created_at=${literal(stamp)},updated_at=${literal(stamp)},last_scanned_at=NULL,status_observed_at=NULL WHERE id=${literal(tree)}`,
          `INSERT INTO git_operations(id,owner_id,project_id,worktree_id,worker_id,type,state,original_head,current_head,source_ref,source_revision,target_ref,target_revision,pending_commits,current_step,total_steps,conflicted_paths,output,checkpoint_ref,created_at,updated_at) VALUES(${literal(id)},${literal(owner)},${literal(project)},${literal(tree)},${literal(worker)},'rebase','running',${literal(context.originalHead)},${literal(context.originalHead)},${literal(context.sourceRef)},${literal(context.sourceRevision)},${literal(context.targetRef)},${literal(context.targetRevision)},${json(context.pendingCommits)},0,1,'[]','before',${literal(context.checkpointRef)},${literal(stamp)},${literal(stamp)})`,
        ],
        onCommand: async (command) => {
          if (command.type === "worktree.observation.configure")
            return { accepted: true, paths: [] };
          if (command.type === "git.operation.inspect") {
            result.commands.push(command);
            assert.equal(command.cwd, worktreePath);
            assert.deepEqual(command.context, context);
            return inspect(command);
          }
        },
      });
      const server = h.fixture.server;
      result.owner = h.owner;
      const retainedFixture = h.fixture;
      const retainedHarness = h;
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
      const read = async () => {
        const row = (
          await executeSql(
            [],
            [
              `SELECT jsonb_build_object('operation',to_jsonb(g),'worktree',(SELECT to_jsonb(w) FROM project_worktrees w WHERE id=${literal(tree)}))::text result FROM git_operations g WHERE id=${literal(id)}`,
            ],
          )
        )[0];
        result.lastState = row;
        return row;
      };
      try {
        if (values.production)
          result.observations.push(
            await retainedFixture.observe(
              "SQL test route absent",
              "POST",
              "/__fixture/sql",
              {
                csrf: true,
                json: { statements: [], queries: [] },
                status: 404,
              },
            ),
          );
        await h.live.subscribed("git-operation-observation", [
          { kind: "project", projectId: project },
        ]);
        result.before = await read();
        result.notification = notification;
        result.startedAt = Date.now();
        assert.equal(h.worker.sendNotification(notification), true);
        await eventually(read, (row) =>
          assert.equal(row.operation.state, "completed"),
        );
        await eventually(
          () =>
            h.live.history.filter(
              (e) =>
                e.type === "event" &&
                [
                  "worktree-status",
                  "worktree",
                  "git-operation",
                  "git-conflict",
                ].includes(e.resource),
            ),
          (events) => {
            result.events = events;
            assert.deepEqual(
              events.map((e) => e.resource),
              [
                "worktree-status",
                "worktree",
                "git-operation",
                "git-conflict",
                "worktree",
                "worktree",
              ],
            );
          },
        );
        result.after = await read();
        assert.equal(
          result.after.operation.output,
          "before\ninspected completion",
        );
        assert.equal(result.after.worktree.head, completed.currentHead);
        assert.equal(result.commands.length, 1);
        result.finishedAt = Date.now();
        result.actions = [
          {
            name: "initial completed observation",
            before: result.before,
            after: result.after,
            events: result.events,
            commands: [...result.commands],
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
          },
        ];
        if (!values["initial-only"])
          await gitObservationScenarios(
            h,
            result,
            read,
            (next) => {
              inspect = next;
            },
            executeSql,
          );
        result.retained = await read();
        if (values["held-shutdown"]) {
          await executeSql([
            `UPDATE git_operations SET state='running',pending_commits=${json(context.pendingCommits)},completed_at=NULL WHERE id=${literal(id)}`,
          ]);
          const expected = await read();
          const state = {
            ...completed,
            currentHead: "9".repeat(40),
            output: "held during shutdown",
            status: { ...completed.status, head: "9".repeat(40) },
          };
          let release,
            entered = false;
          const held = new Promise((resolve) => (release = resolve));
          inspect = async () => {
            entered = true;
            await held;
            return state;
          };
          result.heldShutdown = {
            before: expected,
            workerState: state,
            startedAt: Date.now(),
          };
          assert.equal(
            h.worker.sendNotification(
              observation(state, undefined, {
                observedAt: new Date().toISOString(),
              }),
            ),
            true,
          );
          await eventually(
            () => entered,
            (value) => assert.equal(value, true),
          );
          try {
            await retainedFixture.close({ shutdownTimeoutMs: 8000 });
          } finally {
            release();
            result.heldShutdown.finishedAt = Date.now();
          }
          result.retained = expected;
        }
        result.passed = true;
      } finally {
        result.diagnostics = server.diagnostics();
        await h.close();
        h = null;
        result.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
      }
      assert.deepEqual(result.exit, { code: 0, signal: null });
      if (result.passed && !values["initial-only"]) {
        await retainedFixture.start({
          port: Number(new URL(server.origin).port),
        });
        const restarted = retainedFixture.server;
        let restartedLive;
        result.restart = {};
        try {
          result.restart.state = await read();
          assert.deepEqual(
            result.restart.state,
            result.retained,
            "Restart retains exact Git/worktree state and clocks",
          );
          if (values["held-shutdown"]) {
            restartedLive = await new LiveProbe(retainedFixture).open();
            await restartedLive.initialized();
            await restartedLive.subscribed("git-recovery", [
              { kind: "project", projectId: project },
            ]);
            await retainedHarness.reconnectWorker();
            const action = {
              name: "active Git observation after held shutdown and restart",
              before: await read(),
              startedAt: Date.now(),
            };
            result.actions.push(action);
            const commandStart = result.commands.length;
            assert.equal(
              retainedHarness.worker.sendNotification(
                observation(result.heldShutdown.workerState, undefined, {
                  observedAt: new Date().toISOString(),
                }),
              ),
              true,
            );
            await eventually(read, (row) =>
              assert.equal(row.operation.state, "completed"),
            );
            const events = () =>
              restartedLive.history.filter(
                (e) =>
                  e.type === "event" &&
                  [
                    "worktree-status",
                    "worktree",
                    "git-operation",
                    "git-conflict",
                  ].includes(e.resource),
              );
            await eventually(events, (e) =>
              assert.deepEqual(
                e.map((x) => x.resource),
                [
                  "worktree-status",
                  "worktree",
                  "git-operation",
                  "git-conflict",
                  "worktree",
                  "worktree",
                ],
              ),
            );
            await restartedLive.ping("recovered Git state");
            action.after = await read();
            action.events = events();
            action.commands = result.commands.slice(commandStart);
            action.finishedAt = Date.now();
            assert.equal(action.commands.length, 1);
            assert.equal(
              action.after.operation.output,
              action.before.operation.output +
                "\n" +
                result.heldShutdown.workerState.output,
            );
            result.restart.recovered = action.after;
          }
        } finally {
          await restartedLive?.close();
          await retainedHarness.close();
          result.restart.exit = {
            code: restarted.child.exitCode,
            signal: restarted.child.signalCode,
          };
        }
        assert.deepEqual(result.restart.exit, { code: 0, signal: null });
      }
      await databaseClient?.end({ timeout: 5 });
      databaseClient = null;
    }
    assert.deepEqual(
      normalizeGitActions(peers[1]),
      normalizeGitActions(peers[0]),
      profile + " exact durable/live comparison",
    );
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
  }),
);
