// Public Task dashboard and Chat Goal controls against both actual servers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import {
  seedEventChats,
  task,
  taskProject,
  taskTree,
} from "./native-event-http-setup.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsProject,
  settingsTree,
  settingsWorker,
  until,
} from "./native-settings-http-fixture.mjs";
import {
  dashboardGoalWorker,
  goalMarker,
  ordinaryObjective,
} from "./task-dashboard-goal-worker.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-dashboard-goals-"),
);
const id = (n) => `e5e5e5e5-5555-4555-8555-${String(n).padStart(12, "0")}`;
const disabled = id(1),
  notStarted = id(2),
  noFinal = id(3),
  noThread = id(4),
  orphan = id(5),
  resume = id(6),
  pausedAgent = id(7),
  noThreadAgent = id(8),
  folder = id(9),
  unlinked = id(10),
  missing = id(11);
const folderProject = "dashboard-folder-project",
  folderTree = "dashboard-folder-root",
  oldTree = "dashboard-old-tree";
const variants = [
  task,
  disabled,
  notStarted,
  noFinal,
  noThread,
  orphan,
  resume,
  pausedAgent,
  noThreadAgent,
  folder,
  unlinked,
];
const report = {
  suite: "public-task-dashboard-goals-http",
  databaseMode,
  completeReplacement: false,
  fullWorkerProcess: false,
  profiles: [],
};
let pg, active, controller, failure;
try {
  const executable = await buildRustServer();
  const repositoryExecutable = await buildRustExample(
    "project-repository-fixture",
  );
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (v) => !option("--profile") || option("--profile") === v,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        taskProofs: 0,
        goalProofs: 0,
      };
      outputs.push(result);
      const worker = (controller = dashboardGoalWorker());
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: (owner) => [
          ...seedEventChats(owner),
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('dashboard-provider',${literal(owner)},'Controlled provider','openai-compatible','http://fixture.invalid')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('dashboard-model',${literal(owner)},'Goal model')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('dashboard-route','dashboard-model','dashboard-provider','controlled',0)",
          `UPDATE user_settings SET auto_name_chats=false,auto_name_tasks=false,default_model_id='dashboard-model' WHERE user_id=${literal(owner)}`,
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25T00:00:00.000Z',github_repository_full_name='fixture/repository',github_repository_url='https://github.com/fixture/repository' WHERE id=${literal(taskProject)}`,
          `UPDATE chats SET model_id='dashboard-model',automation_paused=true WHERE id IN (${[task, settingsChat].map(literal).join(",")})`,
          `UPDATE chat_runtime_sessions SET model_route_id='dashboard-route' WHERE chat_id IN (${[task, settingsChat].map(literal).join(",")})`,
          `UPDATE project_worktrees SET branch='task-branch',created_at='2026-10-25T00:00:00.000Z',updated_at='2026-10-25T00:00:00.000Z',status_snapshot=${json(
            {
              status: {
                branch: "task-branch",
                head: "a".repeat(40),
                files: [
                  { path: "changed", status: "modified" },
                  { path: "second", status: "added" },
                ],
              },
            },
          )} WHERE id=${literal(taskTree)}`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,created_at,updated_at,status_snapshot) VALUES(${literal(oldTree)},'event-task-source',${literal(settingsWorker)},'Old branch','/old','/old',false,'cantrip','ready','old-branch','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z',${json({ status: { files: [{ path: "old", status: "modified" }] } })})`,
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id) VALUES(${literal(folderProject)},${literal(owner)},${json(label("project"))},'managed-folder','external',false,false,'direct',${literal(settingsWorker)})`,
          `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('dashboard-folder-source',${literal(folderProject)},${literal(settingsWorker)},'folder','/folder','/display-folder')`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,root_kind) VALUES(${literal(folderTree)},'dashboard-folder-source',${literal(settingsWorker)},'Folder','/folder','/display-folder',true,true,'external','ready','folder-root')`,
          ...variants
            .filter((chat) => chat !== task)
            .map(
              (chat) =>
                `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id,automation_paused) SELECT ${literal(chat)},owner_id,${literal(chat === folder ? folderProject : chat === unlinked ? settingsProject : taskProject)},${literal(chat === folder ? folderTree : chat === unlinked ? settingsTree : taskTree)},active_worker_id,protected_label,${literal([pausedAgent, noThreadAgent].includes(chat) ? "agent" : "task")},'dashboard-model',${![resume, noThreadAgent].includes(chat)} FROM chats WHERE id=${literal(task)}`,
            ),
          ...variants
            .filter((chat) => chat !== task)
            .map(
              (chat) =>
                `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id) SELECT 'dashboard-runtime-'||id,id,active_worker_id,active_worktree_id,${[noThread, noThreadAgent].includes(chat) ? "NULL" : "'task-thread'"},'dashboard-route' FROM chats WHERE id=${literal(chat)}`,
            ),
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,created_at,updated_at) VALUES('dashboard-old-lane',${literal(task)},${literal(oldTree)},${literal(settingsWorker)},'user','released','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),('dashboard-active-lane',${literal(task)},${literal(taskTree)},${literal(settingsWorker)},'user','released','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')`,
        ],
        prepare: async ({ owner, repository }) => {
          for (const chat of variants.filter(
            (chat) => ![orphan, pausedAgent, noThreadAgent].includes(chat),
          )) {
            const state = chat === notStarted ? "draft" : "implementing";
            const finalized = ![notStarted, noFinal].includes(chat);
            const content = {
              version: 1,
              classification: taskContent(state, finalized ? 1 : 0, {
                hasPlan: finalized,
                hasFinalPlan: finalized,
                hasGoalPrompt: finalized,
              }).classification,
              briefMarkdown: goalMarker,
              planMarkdown: finalized ? goalMarker : null,
              currentQuestions: [],
              currentAnswers: [],
              additionalDirection: "",
              finalPlanMarkdown: finalized ? goalMarker : null,
              goalPrompt: finalized ? goalMarker : null,
              lastError: null,
            };
            const protectedTask = await worker.protectTask(
              owner,
              chat,
              content,
            );
            const seeded = await repository.request({
              op: "transaction",
              statements: [
                `INSERT INTO tasks(chat_id,state,planning_round,has_plan,has_final_plan,has_goal_prompt,plan_goal_enabled,protected_content,implementation_started_at,created_at,updated_at) VALUES(${literal(chat)},${literal(state)},${content.classification.planningRound},${finalized},${finalized},${finalized},${chat !== disabled && chat !== folder && chat !== unlinked},${json(protectedTask.protectedContent)},${chat === notStarted ? "NULL" : "'2026-10-25T00:00:00.000Z'"},'2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z')`,
              ],
            });
            assert.equal(seeded.rejected, false, seeded.diagnostic);
          }
        },
        onCommand: (...args) => worker.handle(...args),
      }));
      const dashboard = (chat) => `/api/tasks/${chat}/dashboard`;
      const goal = (chat, query = "") => `/api/chats/${chat}/goal${query}`;
      await h.live.subscribed("dashboard-goal-effects", [
        { kind: "chat", chatId: task },
        { kind: "project", projectId: taskProject },
      ]);
      async function visit(name, method, route, options) {
        const value = await h.visit(name, method, route, options);
        if (value?.task) {
          await worker.proveTask(h.owner, value.task.chatId, value.task);
          result.taskProofs++;
        }
        if (value?.goal?.protectedObjective) {
          if (value.kind === "chat-encrypted")
            await worker.proveMessage(
              h.owner,
              value.goal.protectedObjective,
              false,
            );
          else {
            await worker.proveObjective(h.owner, value.goal);
            result.goalProofs++;
          }
        }
        assert.equal(
          JSON.stringify(value).includes(goalMarker),
          false,
          "Task private content remains opaque",
        );
        return value;
      }
      for (const chat of [missing, settingsChat, orphan])
        await visit("dashboard not a Task " + chat, "GET", dashboard(chat), {
          status: 404,
        });
      for (const chat of [notStarted, noFinal])
        await visit(
          "dashboard implementation guard " + chat,
          "GET",
          dashboard(chat),
          { status: 409 },
        );
      const normal = await visit(
        "Task dashboard with Goal PRs lanes and dirty files",
        "GET",
        dashboard(task),
      );
      assert.equal(normal.placement.dirty, true);
      assert.equal(normal.placement.dirtyFileCount, 2);
      assert.equal(normal.goal.status, "active");
      assert.equal(normal.pullRequests.length, 5);
      assert.ok(normal.warnings.length >= 3);
      await visit("HEAD Task dashboard", "HEAD", dashboard(task));
      await visit("Goal disabled dashboard", "GET", dashboard(disabled));
      const folderResult = await visit(
        "Folder Task dashboard",
        "GET",
        dashboard(folder),
      );
      assert.deepEqual(folderResult.placement, {
        kind: "folder",
        workerId: settingsWorker,
        rootId: folderTree,
        displayPath: "/display-folder",
      });
      assert.deepEqual(folderResult.warnings, []);
      const noGithub = await visit(
        "Unlinked Task dashboard",
        "GET",
        dashboard(unlinked),
      );
      assert.equal(
        noGithub.pullRequestsUnavailableReason,
        "This project is not linked to a GitHub repository.",
      );
      const threadless = await visit(
        "Task dashboard missing native thread",
        "GET",
        dashboard(noThread),
      );
      assert.equal(
        threadless.goalUnavailableReason,
        "The Task Chat has no active Codex thread.",
      );
      for (const mode of [
        "null",
        "error",
        "invalid",
        "wrong-chat",
        "wrong-thread",
        "wrong-execution",
      ]) {
        worker.mode(mode);
        const value = await visit(
          "dashboard Goal " + mode,
          "GET",
          dashboard(task),
        );
        assert.equal(value.goal, null);
        assert.ok(value.goalUnavailableReason);
        await visit("Task Goal read " + mode, "GET", goal(task), {
          status: mode === "null" ? 200 : 409,
        });
      }
      worker.mode("normal");
      worker.prMode("early-failure");
      const held = worker.holdClosed();
      const failed = await visit(
        "PR failure keeps second admitted request alive",
        "GET",
        dashboard(task),
      );
      assert.equal(
        failed.pullRequestsUnavailableReason,
        "Controlled PR failure",
      );
      await until(() => held.requested, Boolean);
      assert.equal(
        held.settled,
        false,
        "HTTP failure precedes other worker response",
      );
      held.release();
      await until(() => held.settled, Boolean);
      result.pairedPrAdmission = true;
      worker.prMode("long-error");
      const truncated = await visit(
        "PR error UTF16 truncation",
        "GET",
        dashboard(task),
      );
      assert.equal(
        truncated.pullRequestsUnavailableReason,
        "x".repeat(1999) + "\ud83d",
      );
      worker.prMode("invalid");
      await visit("Invalid PR response", "GET", dashboard(task));
      worker.prMode("normal");
      for (const chat of [task, noThread, noThreadAgent, settingsChat])
        await visit("Goal read " + chat, "GET", goal(chat));
      await visit("HEAD Goal", "HEAD", goal(task));
      await visit(
        "Ordinary encrypted Goal read",
        "GET",
        goal(settingsChat, "?encrypted=1"),
      );
      await visit(
        "Other query does not request protection",
        "GET",
        goal(settingsChat, "?encrypted=true"),
      );
      for (const method of ["GET", "POST", "PATCH", "DELETE"])
        await visit("missing Goal " + method, method, goal(missing), {
          status: 404,
          ...(["POST", "PATCH"].includes(method)
            ? {
                json:
                  method === "POST"
                    ? { objective: ordinaryObjective }
                    : { status: "paused" },
              }
            : {}),
        });
      for (const [method, jsonBody] of [
        ["POST", {}],
        ["POST", { objective: "  " }],
        ["POST", { objective: ordinaryObjective, tokenBudget: 0 }],
        ["PATCH", {}],
        ["PATCH", { status: "unknown" }],
        ["PATCH", { status: "paused", extra: true }],
        ["PATCH", null],
      ])
        await visit(
          "invalid Goal body " + method + JSON.stringify(jsonBody),
          method,
          goal(missing),
          { status: 400, json: jsonBody },
        );
      await visit(
        "Task Goal creation belongs to finalization",
        "POST",
        goal(task),
        { status: 409, json: { objective: ordinaryObjective } },
      );
      await visit("Paused Chat cannot create Goal", "POST", goal(pausedAgent), {
        status: 409,
        json: { objective: ordinaryObjective },
      });
      await visit("Threadless update", "PATCH", goal(noThread), {
        status: 409,
        json: { status: "paused" },
      });
      await visit("Threadless clear", "DELETE", goal(noThread));
      await visit("Orphan Task Goal read", "GET", goal(orphan), {
        status: 404,
      });
      await visit("Orphan Task Goal update", "PATCH", goal(orphan), {
        status: 404,
        json: { status: "paused" },
      });
      await visit(
        "Orphan Task Goal clear needs no Task row",
        "DELETE",
        goal(orphan),
      );
      for (const status of ["paused", "active"])
        await visit("Task Goal update " + status, "PATCH", goal(task), {
          json: { status },
        });
      for (const mode of ["error", "invalid", "null", "wrong-chat"]) {
        worker.mode(mode);
        await visit("Task Goal update failure " + mode, "PATCH", goal(task), {
          status: 409,
          json: { status: "paused" },
        });
      }
      worker.mode("normal");
      await visit("Ordinary managed Goal pause", "PATCH", goal(settingsChat), {
        json: { status: "paused" },
      });
      const opaque = await visit(
        "Ordinary managed Goal encrypted resume",
        "PATCH",
        goal(settingsChat, "?encrypted=1"),
        { json: { status: "active" } },
      );
      await visit(
        "Protected objective implies encrypted response",
        "PATCH",
        goal(settingsChat),
        { json: { protectedObjective: opaque.goal.protectedObjective } },
      );
      await visit(
        "Create ordinary managed Goal with trimmed input",
        "POST",
        goal(noThreadAgent),
        {
          status: 202,
          json: {
            objective: " " + ordinaryObjective + " ",
            tokenBudget: 1000,
            ignored: true,
          },
        },
      );
      await visit(
        "Create ordinary managed Goal with default budget",
        "POST",
        goal(noThreadAgent),
        { status: 202, json: { objective: ordinaryObjective } },
      );
      for (const chat of [task, settingsChat]) {
        worker.mode("error");
        await visit("Goal removal error " + chat, "DELETE", goal(chat), {
          status: 409,
        });
        worker.mode("normal");
        await visit("Goal removal " + chat, "DELETE", goal(chat));
      }
      if (profile === "accounts")
        for (const [method, route, input] of [
          ["GET", dashboard(task)],
          ["GET", goal(task)],
          ["POST", goal(task), { objective: ordinaryObjective }],
          ["PATCH", goal(task), { status: "paused" }],
          ["DELETE", goal(task)],
        ])
          await visit("foreign owner " + method + route, method, route, {
            client: "other",
            status: 404,
            ...(input ? { json: input } : {}),
          });
      worker.mode("completed");
      const completed = await visit(
        "Worker completion synchronizes dashboard Task",
        "GET",
        dashboard(task),
      );
      assert.equal(completed.task.state, "complete");
      assert.equal(completed.goal.status, "complete");
      assert.ok(
        completed.warnings.some(
          (warning) => warning.code === "complete-with-open-pull-request",
        ),
      );
      worker.mode("wrong-message");
      await visit(
        "Resume rejects unrelated worker message",
        "PATCH",
        goal(resume),
        { status: 409, json: { status: "active" } },
      );
      worker.mode("normal");
      // The resume endpoint returns only after the real runtime has admitted the
      // encrypted user message. Hold the controlled model response past HTTP.
      const gate = worker.holdTurn();
      await visit(
        "Encrypted Task Goal resume admits real turn",
        "PATCH",
        goal(resume),
        { json: { status: "active" } },
      );
      await until(() => gate.requested, Boolean);
      assert.equal(gate.settled, false);
      assert.equal(worker.turns.length, 1);
      gate.release();
      await until(() => gate.settled, Boolean);
      result.resumeAdmission = true;
      h.worker.close();
      // The bridge must observe socket closure, rather than infer offline from
      // the local client's close call.
      {
        const deadline = Date.now() + 15000;
        let disconnected = false;
        while (Date.now() < deadline) {
          const response = await fetch(
            h.fixture.server.origin + "/api/workers",
            {
              headers: {
                cookie: [...h.fixture.client().cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; "),
              },
            },
          );
          assert.equal(response.status, 200);
          const value = await response.json();
          if (
            value.find((w) => w.workerId === settingsWorker)?.online === false
          ) {
            disconnected = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(
          disconnected,
          "Worker disconnect was observed through the actual HTTP catalog",
        );
      }
      const offline = await visit(
        "Offline Task dashboard",
        "GET",
        dashboard(task),
      );
      assert.equal(
        offline.goalUnavailableReason,
        "The project worker is offline.",
      );
      assert.equal(
        offline.pullRequestsUnavailableReason,
        "The GitHub project worker is offline.",
      );
      for (const method of ["GET", "PATCH", "DELETE"])
        await visit("offline Goal " + method, method, goal(task), {
          status: 503,
          ...(method === "PATCH" ? { json: { status: "paused" } } : {}),
        });
      await visit(
        "Offline threadless read still returns null",
        "GET",
        goal(noThread),
      );
      await visit(
        "Offline threadless clear still returns false",
        "DELETE",
        goal(noThread),
      );
      const taskEvents = () =>
        h.live.history.filter(
          (event) =>
            event.type === "event" &&
            event.resource === "task" &&
            (event.scope.kind === "chat"
              ? event.scope.chatId === task
              : event.entityId === task),
        );
      await until(taskEvents, (events) => events.length === 16);
      result.taskEvents = taskEvents().map(
        ({ scope, resource, action, entityId, revision, payload }) => ({
          scope,
          resource,
          action,
          entityId,
          revision,
          payload,
        }),
      );
      assert.deepEqual(
        result.taskEvents.map((event) => event.scope.kind),
        Array.from({ length: 8 }, () => ["chat", "project"]).flat(),
      );
      result.observations = worker.redact(result.observations);
      const normalizeCommand = (value) => {
        if (Array.isArray(value)) return value.map(normalizeCommand);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              normalizeCommand(child),
            ]),
          );
        if (typeof value === "string") {
          const dynamic = /^(task-goal-resume:|gui-goal:)([0-9a-f-]{36})$/.exec(
            value,
          );
          if (dynamic) return dynamic[1] + h.fixture.normalize(dynamic[2]);
        }
        return value;
      };
      result.commands = worker.commands.map((command) =>
        worker.redact(h.fixture.normalize(normalizeCommand(command))),
      );
      assert.equal(
        h.diagnostics().includes(goalMarker),
        false,
        "private Task content is absent from server diagnostics",
      );
      // The two independent PR reads are concurrent in Source. Preserve every
      // field and each pair while comparing their state-specific commands.
      for (let i = 0; i < result.commands.length; i++)
        if (result.commands[i].type === "github.pull-requests.list") {
          assert.equal(
            result.commands[i + 1]?.type,
            "github.pull-requests.list",
          );
          const pair = result.commands
            .slice(i, i + 2)
            .sort((a, b) => a.state.localeCompare(b.state));
          assert.deepEqual(
            pair.map((c) => c.state),
            ["closed", "open"],
          );
          result.commands.splice(i, 2, ...pair);
          i++;
        }
      await h.close();
      active = undefined;
      controller = undefined;
      const repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const durable = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('mainState',(SELECT state FROM tasks WHERE chat_id=${literal(task)}),'mainVersion',(SELECT row_version FROM tasks WHERE chat_id=${literal(task)}),'resumeMessages',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(resume)} AND role='user'),'orphanTask',(SELECT count(*) FROM tasks WHERE chat_id=${literal(orphan)})) result`,
        });
        assert.equal(durable.rejected, false, durable.diagnostic);
        assert.equal(durable.value.mainState, "complete");
        assert.equal(durable.value.mainVersion, 11);
        assert.equal(durable.value.resumeMessages, 1);
        assert.equal(durable.value.orphanTask, 0);
        result.durable = durable.value;
      } finally {
        await repository.close();
      }
    }
    for (const key of [
      "observations",
      "commands",
      "taskEvents",
      "taskProofs",
      "goalProofs",
      "pairedPrAdmission",
      "resumeAdmission",
      "durable",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.serverDiagnostics = active?.diagnostics();
} finally {
  controller?.releaseAll();
  await active?.close();
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map(({ profile, outputs }) => ({
      profile,
      outputs: outputs.map(
        ({ kind, observations, taskProofs, goalProofs }) => ({
          kind,
          observations: observations.length,
          taskProofs,
          goalProofs,
        }),
      ),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
