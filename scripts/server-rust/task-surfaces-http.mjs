// Real public Task creation/deletion/attachment sockets and committed bindings.
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
import { deferredAttachment } from "./native-settlement-fixtures.mjs";
import {
  seedEventChats,
  task,
  taskProject,
  taskTree,
} from "./native-event-http-setup.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-surfaces-"));
const id = (n) => `e4e4e4e4-4444-4444-8444-${String(n).padStart(12, "0")}`;
const primary = id(1),
  secondary = id(2),
  rejected = id(3),
  missing = id(4);
const running = [id(11), id(12), id(13)];
const branch = "task-surfaces-branch";
const marker = "private-task-surfaces-content";
const model = {
  modelId: "task-surfaces-model",
  reasoningEffort: null,
  customSubagentModel: true,
  subagentModelId: "task-surfaces-subagent",
  subagentReasoningEffort: null,
};
const report = {
  suite: "public-task-surfaces-http-live",
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
        interrupts: [],
      };
      outputs.push(result);
      const expected = new Map(),
        proved = new Set();
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const protect = async (owner, chat, state = "draft") => {
        const content = {
          version: 1,
          classification: taskContent(state).classification,
          briefMarkdown: marker,
          planMarkdown: null,
          currentQuestions: [],
          currentAnswers: [],
          additionalDirection: "",
          finalPlanMarkdown: null,
          goalPrompt: null,
          lastError: null,
        };
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
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('task-surfaces-provider',${literal(owner)},'Controlled Task provider','openai-compatible','http://fixture.invalid')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('task-surfaces-model',${literal(owner)},'Task root'),('task-surfaces-subagent',${literal(owner)},'Task subagent')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('task-surfaces-route','task-surfaces-model','task-surfaces-provider','root',0),('task-surfaces-subagent-route','task-surfaces-subagent','task-surfaces-provider','child',0)",
          `UPDATE user_settings SET auto_name_chats=false,auto_name_tasks=false,default_model_id='task-surfaces-model',default_custom_subagent_model=true,default_subagent_model_id='task-surfaces-subagent' WHERE user_id=${literal(owner)}`,
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25' WHERE id=${literal(taskProject)}`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,head) VALUES(${literal(branch)},'event-task-source',${literal(settingsWorker)},'Task branch','/event-task-branch','/event-task-branch',false,'cantrip','ready','task-branch-head')`,
          ...running.map(
            (chat) =>
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id) SELECT ${literal(chat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'task','task-surfaces-model' FROM chats WHERE id=${literal(task)}`,
          ),
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) SELECT 'task-surfaces-'||id,id,active_worker_id,active_worktree_id,'task-deletion-thread' FROM chats WHERE id IN (${running.map(literal).join(",")})`,
          // Stage executing states after startup's interrupted-Chat recovery.
          // These are durable HTTP guard fixtures, not real model execution.
          `CREATE FUNCTION task_surfaces_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_id=${literal(rejected)} THEN RAISE EXCEPTION 'unique cause is not the Drizzle top-level message'; END IF; IF NEW.chat_id=${literal(primary)} THEN UPDATE chats SET status='running' WHERE id=${literal(running[1])}; UPDATE chats SET status='waiting-for-approval' WHERE id=${literal(running[2])}; END IF; RETURN NEW; END $$`,
          "CREATE TRIGGER task_surfaces_reject BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION task_surfaces_reject()",
        ],
        prepare: async ({ owner, repository }) => {
          for (const chat of [task, ...running]) {
            const state = chat === task ? "draft" : "implementing";
            const content = await protect(owner, chat, state);
            const seeded = await repository.request({
              op: "transaction",
              statements: [
                `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content,draft_attachment_ids) VALUES(${literal(chat)},${literal(state)},false,${json(content.protectedContent)},${json(chat === task ? ["task-two", "missing-attachment", "task-one", "foreign-attachment"] : [])})`,
              ],
            });
            assert.equal(seeded.rejected, false, seeded.diagnostic);
          }
          for (const [attachmentId, chat] of [
            ["task-one", task],
            ["task-two", task],
            ["foreign-attachment", settingsChat],
          ]) {
            const attachment = deferredAttachment(attachmentId, chat);
            const seeded = await repository.request({
              op: "transaction",
              statements: [
                `INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status,created_at) VALUES(${literal(attachment.id)},${literal(chat)},${literal(settingsWorker)},${json(attachment.protectedMetadata)},3,'ready',${literal(attachment.createdAt)})`,
              ],
            });
            assert.equal(seeded.rejected, false, seeded.diagnostic);
          }
        },
        onCommand: async (command) => {
          if (command.type !== "chat.interrupt") return undefined;
          assert.equal(command.executionProfile, "ide");
          assert.equal(command.threadId, "task-deletion-thread");
          assert.equal(command.model.id, model.modelId);
          result.interrupts.push(command.chatId);
          if (command.chatId === running[1])
            throw new Error("Controlled Task interruption failed");
          if (command.chatId === running[2]) return { interrupted: "invalid" };
          return { interrupted: true };
        },
      }));
      await h.live.subscribed("task-surfaces", [
        { kind: "project", projectId: taskProject },
        ...running.map((chatId) => ({
          kind: "chat",
          chatId,
        })),
      ]);
      const prove = async (summary) => {
        const key = JSON.stringify(summary.protectedContent);
        assert.ok(
          expected.has(key),
          "only an admitted Task ciphertext is returned",
        );
        const publicClassification = Object.fromEntries(
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
          publicClassification,
        });
        assert.deepEqual(content, expected.get(key));
        assert.equal(JSON.stringify(summary).includes(marker), false);
        proved.add(key);
        result.encryptedTaskProofs++;
      };
      const draft = await protect(h.owner, primary);
      const input = {
        chatId: primary,
        titleProtection: label("chat"),
        task: draft,
      };
      for (const [name, body] of [
        ["missing", {}],
        ["null", null],
        ["array", []],
        ["plaintext title", { ...input, title: marker }],
        ["retired worker", { ...input, requestedTaskWorkerId: missing }],
        [
          "ambiguous placement",
          {
            ...input,
            worktreeId: taskTree,
            target: { kind: "project", projectId: taskProject },
          },
        ],
        ["ambiguous pane", { ...input, paneId: "pane", tabGroupId: "legacy" }],
        [
          "nonempty draft",
          {
            ...input,
            task: {
              ...draft,
              classification: { ...draft.classification, hasPlan: true },
            },
          },
        ],
        ["wrong label", { ...input, titleProtection: label("project") }],
      ]) {
        await h.visit(
          "invalid creation " + name,
          "POST",
          `/api/projects/${taskProject}/tasks`,
          { status: 400, json: body },
        );
      }
      await h.visit(
        "missing creation project",
        "POST",
        `/api/projects/${missing}/tasks`,
        { status: 404, json: input },
      );
      await h.visit(
        "target belongs to another project",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        {
          status: 409,
          json: { ...input, target: { kind: "project", projectId: missing } },
        },
      );
      await h.visit(
        "unknown worktree",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        { status: 409, json: { ...input, worktreeId: missing } },
      );
      if (profile === "accounts") {
        await h.visit(
          "foreign creation project",
          "POST",
          `/api/projects/${taskProject}/tasks`,
          { client: "other", status: 404, json: input },
        );
        await h.visit(
          "foreign attachments hidden",
          "GET",
          `/api/tasks/${task}/attachments`,
          { client: "other", status: 404 },
        );
        await h.visit(
          "foreign deletion hidden",
          "DELETE",
          `/api/tasks/${running[0]}`,
          { client: "other", status: 404 },
        );
      }
      const created = await h.visit(
        "create Task with defaults",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        { status: 201, json: input },
      );
      await prove(created.task);
      assert.deepEqual(created.task.modelConfiguration, model);
      assert.equal(created.chat.modelId, model.modelId);
      assert.equal(created.chat.customSubagentModel, true);
      assert.equal(created.chat.subagentModelId, model.subagentModelId);
      assert.equal(created.chat.activeWorktreeId, taskTree);
      assert.equal(created.chat.experience, "task");
      assert.equal(created.chat.position, 1);
      assert.equal(created.task.rowVersion, 1);
      assert.equal(created.task.schedulerRevision, 1);
      assert.equal(created.task.planGoalEnabled, false);
      const creationEvents = () =>
        h.live.history.filter(
          (event) =>
            event.type === "event" &&
            event.resource === "task" &&
            event.entityId === primary,
        );
      // A new Chat cannot be subscribed before it exists. Creation reaches the
      // already authorized project scope; subsequent Chat subscriptions follow.
      await until(creationEvents, (events) => events.length === 1);
      result.creationEvents = creationEvents().map(
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
        result.creationEvents.map((event) => event.scope.kind).sort(),
        ["project"],
      );
      await prove(
        await h.visit(
          "read newly created Task",
          "GET",
          `/api/tasks/${primary}`,
        ),
      );
      await h.visit(
        "duplicate Chat rolls back",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        { status: 500, json: input },
      );
      const duplicate = structuredClone(input);
      duplicate.titleProtection.protectedLabel.envelope.ciphertext =
        "duplicate" + "A".repeat(34);
      await h.visit(
        "top-level duplicate parameter conflict",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        { status: 409, json: duplicate },
      );
      const other = await h.visit(
        "create pinned Task with independent model",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        {
          status: 201,
          json: {
            ...input,
            chatId: secondary,
            task: await protect(h.owner, secondary),
            target: {
              kind: "worktree",
              projectId: taskProject,
              worktreeId: branch,
            },
            worktreeMode: "pinned",
            paneId: "absent-pane-is-not-attached",
            priority: 3,
            planGoalEnabled: true,
            modelConfiguration: {
              ...model,
              modelId: "unavailable-per-task-model",
            },
          },
        },
      );
      await prove(other.task);
      assert.equal(
        other.task.modelConfiguration.modelId,
        "unavailable-per-task-model",
      );
      assert.equal(other.chat.modelId, model.modelId);
      assert.equal(other.chat.activeWorktreeId, branch);
      assert.equal(other.chat.position, 2);
      await h.visit(
        "Task failure rolls back Chat session and lane",
        "POST",
        `/api/projects/${taskProject}/tasks`,
        {
          status: 500,
          json: {
            ...input,
            chatId: rejected,
            task: await protect(h.owner, rejected),
          },
        },
      );
      const configuration = {
        ...model,
        customSubagentModel: false,
        subagentModelId: null,
      };
      for (const [name, body] of [
        ["missing", {}],
        ["null", null],
        ["unselected root", { modelId: null }],
        ["blank root", { modelId: " " }],
        [
          "missing custom subagent",
          { modelId: model.modelId, customSubagentModel: true },
        ],
      ])
        await h.visit(
          "invalid model configuration " + name,
          "PATCH",
          `/api/chats/${primary}/model-configuration`,
          { status: 400, json: body },
        );
      await h.visit(
        "missing model configuration Chat",
        "PATCH",
        `/api/chats/${missing}/model-configuration`,
        { status: 404, json: configuration },
      );
      await h.visit(
        "unavailable model configuration root",
        "PATCH",
        `/api/chats/${primary}/model-configuration`,
        { status: 409, json: { ...configuration, modelId: missing } },
      );
      await h.visit(
        "unsupported custom subagents",
        "PATCH",
        `/api/chats/${primary}/model-configuration`,
        { status: 409, json: model },
      );
      for (const chat of running.slice(1)) {
        const active = await h.visit(
          "active Chat rejects model update " + chat,
          "PATCH",
          `/api/chats/${chat}/model-configuration`,
          { status: 409, json: configuration },
        );
        assert.equal(active.code, "chat-runtime-active");
        assert.equal(active.retryable, true);
      }
      if (profile === "accounts")
        await h.visit(
          "foreign model configuration hidden",
          "PATCH",
          `/api/chats/${primary}/model-configuration`,
          { client: "other", status: 404, json: configuration },
        );
      const configured = await h.visit(
        "update Chat model configuration",
        "PATCH",
        `/api/chats/${primary}/model-configuration`,
        { json: configuration },
      );
      assert.equal(configured.modelId, model.modelId);
      assert.equal(configured.customSubagentModel, false);
      assert.equal(configured.subagentModelId, null);
      const retained = await h.visit(
        "Chat configuration preserves per-Task configuration",
        "GET",
        `/api/tasks/${primary}`,
      );
      await prove(retained);
      assert.deepEqual(retained.modelConfiguration, model);
      const attachments = await h.visit(
        "ordered draft attachments omit missing and foreign rows",
        "GET",
        `/api/tasks/${task}/attachments`,
      );
      assert.deepEqual(
        attachments.map((attachment) => attachment.id),
        ["task-two", "task-one"],
      );
      for (const attachment of attachments)
        assert.equal("workerId" in attachment, false);
      await h.visit(
        "attachments HEAD",
        "HEAD",
        `/api/tasks/${task}/attachments`,
      );
      assert.deepEqual(
        await h.visit(
          "new Task has no draft attachments",
          "GET",
          `/api/tasks/${primary}/attachments`,
        ),
        [],
      );
      await h.visit(
        "ordinary Chat has no Task attachments",
        "GET",
        `/api/tasks/${settingsChat}/attachments`,
        { status: 404 },
      );
      await h.visit(
        "missing Task attachments",
        "GET",
        `/api/tasks/${missing}/attachments`,
        { status: 404 },
      );
      for (const chat of running) {
        await h.visit(
          "delete running Task " + chat,
          "DELETE",
          `/api/tasks/${chat}`,
          { status: 204 },
        );
        await h.visit(
          "deleted Task is absent " + chat,
          "GET",
          `/api/tasks/${chat}`,
          { status: 404 },
        );
      }
      assert.deepEqual(result.interrupts, running);
      await h.visit("delete missing Task", "DELETE", `/api/tasks/${missing}`, {
        status: 404,
      });
      await h.visit(
        "delete ordinary Chat as Task",
        "DELETE",
        `/api/tasks/${settingsChat}`,
        { status: 404 },
      );
      await prove(
        await h.visit(
          "retained Task after failed mutations",
          "GET",
          `/api/tasks/${primary}`,
        ),
      );
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
          sql: `SELECT jsonb_build_object('primaryTask',(SELECT count(*) FROM tasks WHERE chat_id=${literal(primary)}),'primaryRuntime',(SELECT count(*) FROM chat_runtime_sessions WHERE chat_id=${literal(primary)}),'primaryLane',(SELECT count(*) FROM chat_execution_lanes l JOIN chat_runtime_sessions r ON r.id=l.runtime_session_id WHERE l.chat_id=${literal(primary)} AND r.chat_id=l.chat_id AND NOT l.exclusive AND l.state='suspended' AND l.purpose='Initial chat worktree'),'secondaryLane',(SELECT count(*) FROM chat_execution_lanes WHERE chat_id=${literal(secondary)} AND exclusive AND state='suspended' AND starting_head='task-branch-head'),'paneMemberships',(SELECT count(*) FROM tab_group_members WHERE tab_id IN (${[primary, secondary].map(literal).join(",")})),'failedChats',(SELECT count(*) FROM chats WHERE id=${literal(rejected)}),'failedRuntimes',(SELECT count(*) FROM chat_runtime_sessions WHERE chat_id=${literal(rejected)}),'failedLanes',(SELECT count(*) FROM chat_execution_lanes WHERE chat_id=${literal(rejected)}),'deletedChats',(SELECT count(*) FROM chats WHERE id IN (${running.map(literal).join(",")})),'deletedTasks',(SELECT count(*) FROM tasks WHERE chat_id IN (${running.map(literal).join(",")})),'deletedRuntimes',(SELECT count(*) FROM chat_runtime_sessions WHERE chat_id IN (${running.map(literal).join(",")})),'deletedLanes',(SELECT count(*) FROM chat_execution_lanes WHERE chat_id IN (${running.map(literal).join(",")}))) result`,
        });
        assert.equal(durable.rejected, false, durable.diagnostic);
        assert.deepEqual(durable.value, {
          primaryTask: 1,
          primaryRuntime: 1,
          primaryLane: 1,
          secondaryLane: 1,
          paneMemberships: 0,
          failedChats: 0,
          failedRuntimes: 0,
          failedLanes: 0,
          deletedChats: 0,
          deletedTasks: 0,
          deletedRuntimes: 0,
          deletedLanes: 0,
        });
        result.durable = durable.value;
      } finally {
        await repository.close();
      }
    }
    for (const key of [
      "observations",
      "creationEvents",
      "interrupts",
      "encryptedTaskProofs",
      "durable",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.serverDiagnostics = active?.fixture.server?.diagnostics();
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
