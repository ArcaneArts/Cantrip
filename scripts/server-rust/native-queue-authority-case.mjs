import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.ts";
import {
  settingsChat as chat,
  until,
} from "./native-settings-http-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal } from "./project-target-state.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";
import { nativeQueueInputs } from "./native-queue-http-authorization.mjs";

export async function nativeQueueAuthorityCase({ h, result }) {
  const query = async (sql) => (await h.fixture.sql([], [sql]))[0];
  const foreignOwner = (
    await query(
      "SELECT jsonb_build_object('id',id)::text result FROM users WHERE email='other-settings@example.invalid'",
    )
  ).id;
  assert.notEqual(foreignOwner, h.owner);
  const foreignWorkerId = "foreign-native-queue-worker",
    project = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    foreignChat = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    tree = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const code = await h.visit(
    "foreign queue enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    {
      client: "other",
      status: 201,
      json: { label: "Foreign queue worker" },
    },
  );
  const enrollment = await h.visit(
    "foreign queue enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      status: 201,
      json: {
        code: code.code,
        heartbeat: { ...heartbeat, workerId: foreignWorkerId },
      },
    },
  );
  await h.fixture.sql([
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) SELECT ${literal(project)},${literal(foreignOwner)},protected_label,origin_kind,git_capability,github_capability,worktree_policy,${literal(foreignWorkerId)},'foreign-native-queue' FROM projects WHERE id=${literal(h.scope.projectId)}`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('foreign-native-queue-source',${literal(project)},${literal(foreignWorkerId)},'git','/foreign-native-queue','/foreign-native-queue')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(tree)},'foreign-native-queue-source',${literal(foreignWorkerId)},'main','/foreign-native-queue','/foreign-native-queue',true,'cantrip','ready')`,
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,worktree_mode,protected_label,experience) SELECT ${literal(foreignChat)},${literal(foreignOwner)},${literal(project)},${literal(tree)},${literal(foreignWorkerId)},worktree_mode,protected_label,'agent' FROM chats WHERE id=${literal(chat)}`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('foreign-native-queue-runtime',${literal(foreignChat)},${literal(foreignWorkerId)},${literal(tree)},'foreign-queue-thread')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('foreign-queue-model',${literal(foreignOwner)},'Foreign queue model')`,
  ]);
  const session = {
    ...h.prepared[chat].session,
    chatId: foreignChat,
    projectId: project,
    placementId: tree,
    threadId: "foreign-queue-thread",
  };
  const foreignClient = new ManagedNativeQueueClient({
    serverUrl: h.fixture.server.origin,
    workerId: foreignWorkerId,
    token: () => enrollment.credential,
  });
  const foreignContent = nativeQueueHttpContent(
    {
      ...h,
      owner: foreignOwner,
      encryption: { ...h.encryption, ownerId: () => foreignOwner },
    },
    result,
    "foreign",
  );
  let connected = false;
  const notices = [];
  const worker = new WorkerConnection(
    {
      serverUrl: h.fixture.server.origin,
      dataDirectory: path.join(
        h.fixture.environment.CANTRIP_DATA_DIR,
        "foreign-queue-worker",
      ),
      name: "Foreign queue worker",
      enrollmentCode: null,
      replacement: null,
      token: enrollment.credential,
      tokenSource: "persisted",
      workerId: foreignWorkerId,
    },
    async (command) => {
      if (command.type === "chat.queue.changed") {
        assert.equal(command.chatId, foreignChat);
        notices.push(command);
        await foreignClient.read({ session });
        return null;
      }
      throw new Error("Controlled foreign queue command is unsupported");
    },
    undefined,
    undefined,
    undefined,
    1000,
    () => {
      connected = true;
    },
  );
  const live = await new LiveProbe(h.fixture, { client: "other" }).open();
  try {
    worker.start();
    await until(() => connected, Boolean);
    await live.initialized();
    await live.subscribed("foreign-queue-owner", [
      { kind: "chat", chatId: foreignChat },
    ]);
    const foreignPrompt = await foreignContent.prompt({
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
      messageId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc5",
      modelId: "foreign-queue-model",
      key: "foreign-queue-input",
      text: "Private other-owner queue input 🍃",
    });
    assert.deepEqual(
      await foreignContent.sdk("foreign SDK reads its real queue", () =>
        foreignClient.read({ session }),
      ),
      { revision: 0, paused: false, items: [], claims: [], pendingImports: [] },
    );
    // The first read creates revision zero with a pending outbox notice. Drain
    // that real notice before adding a prompt so scheduling cannot coalesce it
    // with revision one on either implementation.
    const acknowledged = async (revision) => {
      const deadline = Date.now() + 15000;
      let state;
      do {
        state = await query(
          `SELECT jsonb_build_object('revision',revision,'notified',notified_revision)::text result FROM managed_queue_states WHERE chat_id=${literal(foreignChat)}`,
        );
        if (state.notified === revision) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.deepEqual(state, { revision, notified: revision });
      await live.ping("foreign-outbox-" + revision);
    };
    await acknowledged(0);
    assert.equal(live.history.filter((v) => v.type === "event").length, 1);
    const added = await foreignContent.sdk(
      "foreign SDK creates its encrypted queue input",
      () =>
        foreignClient.mutate({
          admission: command({
            workerId: foreignWorkerId,
            operationId: "foreign-queue-add",
            session,
            method: "thread/queue/add",
          }),
          expectedRevision: 0,
          mutation: { kind: "add", prompt: foreignPrompt, attachments: [] },
        }),
    );
    assert.equal(added.receipt.status, "applied");
    // Observe the actual outbox acknowledgment before testing denied requests;
    // an HTTP or socket pong alone cannot drain the independent delivery actor.
    await acknowledged(1);
    assert.deepEqual(
      notices.map((v) => ({
        type: v.type,
        chatId: v.chatId,
        revision: v.revision,
      })),
      [0, 1].map((revision) => ({
        type: "chat.queue.changed",
        chatId: foreignChat,
        revision,
      })),
    );
    await live.ping("foreign-outbox-delivered");
    const beforeEvents = live.history.filter((v) => v.type === "event");
    assert.equal(
      beforeEvents.length,
      3,
      "initial revision, direct mutation and acknowledged durable notice publish exactly once each",
    );
    for (const event of beforeEvents)
      assert.deepEqual(
        {
          scope: event.scope,
          resource: event.resource,
          action: event.action,
          entityId: event.entityId,
          revision: event.revision,
          payload: event.payload,
        },
        {
          scope: { kind: "chat", chatId: foreignChat },
          resource: "chat-queue",
          action: "invalidated",
          entityId: null,
          revision: null,
          payload: null,
        },
      );
    const snapshot = () =>
      query(
        `SELECT jsonb_build_object('prompts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM queued_prompts p WHERE chat_id=${literal(foreignChat)}),'commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n WHERE chat_id=${literal(foreignChat)}),'revision',(SELECT revision FROM managed_queue_states WHERE chat_id=${literal(foreignChat)}))::text result`,
      );
    const before = await snapshot();
    const content = nativeQueueHttpContent(h, result);
    const mainPrompt = await content.prompt({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      messageId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      key: "denied-owner-probe",
      text: "Private denied owner probe 🌱",
    });
    const mainAdmission = command({
      workerId: h.scope.workerId,
      operationId: "denied-foreign-queue",
      method: "thread/queue/add",
      session,
    });
    for (const [action, input] of Object.entries(
      nativeQueueInputs(
        { workerId: h.scope.workerId, session },
        mainAdmission,
        mainPrompt,
      ),
    )) {
      const value = await h.visit(
        "main credential cannot access foreign " + action,
        "POST",
        "/api/internal/native-queue/" + action,
        {
          client: "worker",
          headers: { authorization: "Bearer " + h.credential },
          json: input,
          status: 409,
        },
      );
      assert.deepEqual(
        value,
        ["lookup", "read", "import"].includes(action)
          ? {
              statusCode: 409,
              code: "managed-session-ineligible",
              error: "Conflict",
              message: "managed-session-ineligible",
            }
          : { code: "managed-session-ineligible" },
      );
    }
    assert.deepEqual(
      await snapshot(),
      before,
      "denied cross-owner calls preserve every encrypted row and immutable command",
    );
    await live.ping("foreign-denied-barrier");
    assert.deepEqual(
      live.history.filter((v) => v.type === "event"),
      beforeEvents,
      "denied calls publish no foreign queue changes",
    );
    content.finish();
    foreignContent.finish();
    result.proofs.push(
      "all six actions isolate real foreign-owner queue rows and publish no rejected mutation",
    );
    result.proofs.push(
      "foreign worker receives exactly one notice per drained revision and all three correctly scoped Live invalidations",
    );
  } finally {
    worker.close();
    await live.close();
  }
}
