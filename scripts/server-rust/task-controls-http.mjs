// Real Task HTTP metadata/edits and post-commit Live, with endpoint crypto.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  operationTasks,
  taskOperationHttpCases,
} from "./task-operation-http-cases.mjs";
import { literal, json } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import {
  seedEventChats,
  task,
  taskProject,
} from "./native-event-http-setup.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  componentKey,
  until,
} from "./native-settings-http-fixture.mjs";
import {
  encryptTaskProtectedContent,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-controls-"));
const review = "e2e2e2e2-2222-4222-8222-000000000001";
const missing = "e2e2e2e2-2222-4222-8222-000000000002";
const marker = "private-task-controls-content";
const report = {
  suite: "public-task-controls-http-live",
  databaseMode,
  completeReplacement: false,
  fullWorkerProcess: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable = await buildRustServer();
  const repositoryExecutable = await buildRustExample(
    "project-repository-fixture",
  );
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (value) => !option("--profile") || option("--profile") === value,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        encryptedTaskProofs: 0,
      };
      outputs.push(result);
      const encrypted = new Map();
      const expected = new Map();
      const proved = new Set();
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const plain = (state, text) => ({
        version: 1,
        classification: taskContent(state, state === "draft" ? 0 : 1, {
          hasPlan: state === "review",
          ...(state === "failed"
            ? {
                stableStateBeforeFailure: "draft",
                lastError: {
                  code: "task-operation-failed",
                  operationKind: "initial-plan",
                  occurredAt: "2026-10-25T00:00:00.000Z",
                },
              }
            : {}),
        }).classification,
        briefMarkdown: marker,
        planMarkdown: state === "review" ? text : null,
        currentQuestions: [],
        currentAnswers: [],
        additionalDirection: state === "draft" ? text : "",
        finalPlanMarkdown: null,
        goalPrompt: null,
        lastError:
          state === "failed"
            ? {
                code: "task-operation-failed",
                operationKind: "initial-plan",
                occurredAt: "2026-10-25T00:00:00.000Z",
                message: marker,
              }
            : null,
      });
      const protect = async (owner, chat, content) => {
        const protectedContent = await encryptTaskProtectedContent({
          ownerId: owner,
          chatId: chat,
          keyRevision: 1,
          componentKey,
          content,
        });
        expected.set(JSON.stringify(protectedContent), content);
        return { classification: content.classification, protectedContent };
      };
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
          `UPDATE user_settings SET auto_name_chats=false,auto_name_tasks=false WHERE user_id=${literal(owner)}`,
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25' WHERE id=${literal(taskProject)}`,
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) SELECT ${literal(review)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'task' FROM chats WHERE id=${literal(task)}`,
          ...operationTasks.map(
            ({ chat }) =>
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) SELECT ${literal(chat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'task' FROM chats WHERE id=${literal(task)}`,
          ),
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) SELECT 'task-ops-runtime-'||id,id,active_worker_id,active_worktree_id FROM chats WHERE id IN (${[review, ...operationTasks.map(({ chat }) => chat)].map(literal).join(",")})`,
        ],
        prepare: async ({ owner, repository }) => {
          for (const [chat, state] of [
            [task, "draft"],
            [review, "review"],
            ...operationTasks.map(({ chat, state }) => [chat, state]),
          ]) {
            const content = await protect(
              owner,
              chat,
              plain(state, `${marker}-${state}`),
            );
            encrypted.set(chat, content);
            const seeded = await repository.request({
              op: "transaction",
              statements: [
                `INSERT INTO tasks(chat_id,state,planning_round,has_plan,stable_state_before_failure,last_error,plan_goal_enabled,protected_content,created_at,updated_at) VALUES(${literal(chat)},${literal(state)},${content.classification.planningRound},${state === "review"},${state === "failed" ? "'draft'" : "NULL"},${state === "failed" ? json(content.classification.lastError) : "NULL"},${chat !== operationTasks[0].chat},${json(content.protectedContent)},'2026-10-25','2026-10-25')`,
              ],
            });
            assert.equal(seeded.rejected, false, seeded.diagnostic);
          }
        },
      }));
      await h.live.subscribed("task-controls", [
        { kind: "chat", chatId: task },
        { kind: "chat", chatId: review },
        ...operationTasks.map(({ chat }) => ({ kind: "chat", chatId: chat })),
        { kind: "project", projectId: taskProject },
      ]);
      async function prove(summary) {
        const key = JSON.stringify(summary.protectedContent);
        assert.ok(
          expected.has(key),
          "server returns exactly an admitted ciphertext",
        );
        const classification = Object.fromEntries(
          Object.keys(taskContent().classification).map((key) => [
            key,
            summary[key],
          ]),
        );
        const content = await decryptTaskProtectedContent({
          ownerId: h.owner,
          chatId: summary.chatId,
          keyRevision: 1,
          componentKey,
          encrypted: summary.protectedContent,
          publicClassification: classification,
        });
        assert.deepEqual(content, expected.get(key));
        assert.equal(JSON.stringify(summary).includes(marker), false);
        proved.add(key);
        result.encryptedTaskProofs++;
        return summary;
      }
      const visit = (...args) => h.visit(...args);
      await visit("missing Task", "GET", `/api/tasks/${missing}`, {
        status: 404,
      });
      await visit(
        "ordinary chat is not a Task",
        "GET",
        `/api/tasks/${settingsChat}`,
        { status: 404 },
      );
      const initial = await prove(
        await visit("read encrypted draft", "GET", `/api/tasks/${task}`),
      );
      assert.equal(initial.rowVersion, 1);
      await prove(
        await visit("read encrypted review", "GET", `/api/tasks/${review}`),
      );
      await visit("Task HEAD", "HEAD", `/api/tasks/${task}`);
      for (const [name, body] of [
        ["missing fields", {}],
        ["null", null],
        ["array", []],
        ["invalid revision", { rowVersion: 0, task: encrypted.get(task) }],
      ]) {
        await visit(
          `invalid draft ${name}`,
          "PATCH",
          `/api/tasks/${task}/draft`,
          { json: body, status: 400 },
        );
        await visit(
          `invalid plan ${name}`,
          "PATCH",
          `/api/tasks/${review}/plan`,
          { json: body, status: 400 },
        );
      }
      await visit(
        "draft cannot be edited as a plan",
        "PATCH",
        `/api/tasks/${task}/plan`,
        { json: { rowVersion: 1, task: encrypted.get(task) }, status: 409 },
      );
      const updatedDraft = await protect(
        h.owner,
        task,
        plain("draft", `${marker}-edited-draft`),
      );
      const draft = await prove(
        await visit("commit draft edit", "PATCH", `/api/tasks/${task}/draft`, {
          json: { rowVersion: 1, task: updatedDraft },
        }),
      );
      assert.equal(draft.rowVersion, 2);
      await visit("stale draft revision", "PATCH", `/api/tasks/${task}/draft`, {
        json: { rowVersion: 1, task: updatedDraft },
        status: 409,
      });
      await visit(
        "retired Task Worker assignment is rejected",
        "PATCH",
        `/api/tasks/${task}/draft`,
        {
          json: {
            rowVersion: 2,
            task: updatedDraft,
            requestedTaskWorkerId: missing,
          },
          status: 400,
        },
      );
      await visit(
        "unavailable per-Task model",
        "PATCH",
        `/api/tasks/${task}/draft`,
        {
          json: {
            rowVersion: 2,
            task: updatedDraft,
            modelConfiguration: {
              modelId: missing,
              reasoningEffort: null,
              customSubagentModel: false,
              subagentModelId: null,
              subagentReasoningEffort: null,
            },
          },
          status: 409,
        },
      );
      const updatedPlan = await protect(
        h.owner,
        review,
        plain("review", `${marker}-edited-plan`),
      );
      const plan = await prove(
        await visit("commit plan edit", "PATCH", `/api/tasks/${review}/plan`, {
          json: { rowVersion: 1, task: updatedPlan },
        }),
      );
      assert.equal(plan.rowVersion, 2);
      await visit("stale plan revision", "PATCH", `/api/tasks/${review}/plan`, {
        json: { rowVersion: 1, task: updatedPlan },
        status: 409,
      });
      await visit(
        "review cannot be edited as a draft",
        "PATCH",
        `/api/tasks/${review}/draft`,
        { json: { rowVersion: 2, task: updatedPlan }, status: 409 },
      );
      await visit(
        "valid missing Task edit",
        "PATCH",
        `/api/tasks/${missing}/draft`,
        { json: { rowVersion: 1, task: updatedDraft }, status: 404 },
      );
      if (profile === "accounts") {
        await visit("foreign Task is hidden", "GET", `/api/tasks/${task}`, {
          client: "other",
          status: 404,
        });
        await visit(
          "foreign draft is hidden",
          "PATCH",
          `/api/tasks/${task}/draft`,
          {
            client: "other",
            json: { rowVersion: 2, task: updatedDraft },
            status: 404,
          },
        );
        await visit(
          "foreign plan is hidden",
          "PATCH",
          `/api/tasks/${review}/plan`,
          {
            client: "other",
            json: { rowVersion: 2, task: updatedPlan },
            status: 404,
          },
        );
      }
      await prove(
        await visit(
          "draft retained after rejected writes",
          "GET",
          `/api/tasks/${task}`,
        ),
      );
      await prove(
        await visit(
          "plan retained after rejected writes",
          "GET",
          `/api/tasks/${review}`,
        ),
      );
      const events = () =>
        h.live.history
          .filter(
            (event) => event.type === "event" && event.resource === "task",
          )
          .map(({ scope, resource, action, entityId, revision, payload }) => ({
            scope,
            resource,
            action,
            entityId,
            revision,
            payload,
          }));
      await until(events, (items) => items.length === 4);
      result.taskEvents = events();
      assert.deepEqual(
        result.taskEvents.map((event) => event.scope.kind).sort(),
        ["chat", "chat", "project", "project"],
      );
      for (const event of result.taskEvents)
        if (event.scope.kind === "project")
          assert.equal(event.scope.projectId, taskProject);
      await taskOperationHttpCases({
        h,
        result,
        prove,
        missing,
        draft: task,
        profile,
      });
      function redact(value) {
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => {
              if (key === "protectedContent") {
                assert.ok(
                  proved.has(JSON.stringify(child)),
                  "only independently decrypted Task ciphertext is normalized",
                );
                return [key, "<verified encrypted Task content>"];
              }
              return [key, redact(child)];
            }),
          );
        return value;
      }
      result.observations = redact(result.observations);
      await h.close();
      active = undefined;
    }
    for (const key of [
      "observations",
      "taskEvents",
      "encryptedTaskProofs",
      "queuedOperations",
      "operationEvents",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
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
      outputs: outputs.map(({ kind, observations, encryptedTaskProofs }) => ({
        kind,
        observations: observations.length,
        encryptedTaskProofs,
      })),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
