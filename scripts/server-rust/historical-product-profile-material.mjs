import assert from "node:assert/strict";
// Synthetic, offline product records with real client-library encryption.
// The history receipt is a validated empty checkpoint, not execution replay.
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { queuedPromptOpaqueContentSchema } from "../../packages/protocol/dist/communication-content.js";
import {
  nativeHistoryCommitReceiptSchema,
  nativeHistoryPreparedBatchSchema,
} from "../../packages/protocol/dist/index.js";
import { nativeHistoryPayloadDigest } from "../../tests/reference-node-server/src/db/repository/native-history-digest.ts";
export const ids = {
  owner: "00000000-0000-0000-0000-000000000001",
  worker: "rollback-worker",
  project: "rollback-project",
  source: "rollback-source",
  tree: "rollback-tree",
  chat: "rollback-chat",
  task: "rollback-task",
  model: "rollback-model",
  prompt: randomUUID(),
  pending: randomUUID(),
  message: randomUUID(),
  assistant: randomUUID(),
  document: randomUUID(),
  binding: "rollback-binding",
  stream: randomUUID(),
  commit: randomUUID(),
  client: randomUUID(),
};
export const password = "isolated historical rollback password";
const stamp = "2026-11-07T01:02:03.123Z";
const text = (phase) =>
  `Private ${phase} LF\nCRLF\r\nbare CR\rquotes ' \\" Unicode e\u0301🦀\u2028\u2029 end`;
export const masterKey = crypto.generateAccountMasterKey();
const key = (component) =>
  crypto.deriveComponentKey({
    ownerId: ids.owner,
    accountMasterKey: masterKey,
    component,
    keyRevision: 1,
  });
export const classification = {
  state: "draft",
  stableStateBeforeFailure: null,
  activeOperationKind: null,
  planAuthorship: "agent",
  planningRound: 0,
  hasPlan: false,
  hasQuestions: false,
  hasFinalPlan: false,
  hasGoalPrompt: false,
  lastError: null,
};
export async function makeMaterial(phase, serverId) {
  const common = { ownerId: ids.owner, keyRevision: 1 };
  const label = async (recordKind, rowId, value) =>
    crypto.encryptPrivateDisplayLabel({
      ...common,
      recordKind,
      rowId,
      label: value,
      componentKey: key("private-surface-metadata"),
    });
  const message = async (id, role) => {
    const classification = { role, mode: "default", attachmentIds: [] };
    return {
      id,
      classification,
      idempotencyKey: "rollback:" + id,
      reasoningEffort: null,
      protectedContent: await crypto.encryptChatMessageProtectedContent({
        ...common,
        messageId: id,
        componentKey: key("chat-content"),
        content: {
          version: 1,
          classification,
          content: [{ type: "text", text: text(phase + ":" + role) }],
        },
      }),
    };
  };
  const user = await message(ids.message, "user"),
    assistant = await message(ids.assistant, "assistant"),
    pending = await message(ids.pending, "user");
  const promptClassification = { mode: "default", attachmentIds: [] };
  const prompt = queuedPromptOpaqueContentSchema.parse({
    id: ids.prompt,
    classification: promptClassification,
    protectedContent: await crypto.encryptQueuedPromptProtectedContent({
      ...common,
      promptId: ids.prompt,
      componentKey: key("chat-content"),
      content: {
        version: 1,
        classification: promptClassification,
        text: text(phase + ":queue"),
      },
    }),
    modelId: ids.model,
    worktreeId: ids.tree,
    frozen: true,
    idempotencyKey: "rollback:" + ids.pending,
    pendingMessage: pending,
  });
  const taskContent = {
    version: 1,
    classification,
    briefMarkdown: text(phase + ":task"),
    planMarkdown: null,
    currentQuestions: [],
    currentAnswers: [],
    additionalDirection: "",
    finalPlanMarkdown: null,
    goalPrompt: null,
    lastError: null,
  };
  const task = {
    classification,
    protectedContent: await crypto.encryptTaskProtectedContent({
      ...common,
      chatId: ids.task,
      componentKey: key("task-content"),
      content: taskContent,
    }),
  };
  const draftContent = {
    version: 1,
    text: text(phase + ":draft"),
    mode: "default",
    reasoningEffort: null,
    attachments: [],
  };
  const draft = {
    protectedContent: await crypto.encryptChatComposerDraftProtectedContent({
      ...common,
      chatId: ids.chat,
      componentKey: key("chat-content"),
      content: draftContent,
    }),
  };
  const documentId = phase === "historical" ? ids.document : randomUUID();
  const context = {
    serverId,
    resource: "file-document-row",
    resourceId: documentId,
    operationId: null,
    recordKind: "file-document-state",
  };
  const fileContent = {
    version: 1,
    classification: { recordKind: "file-document-state" },
    projectId: ids.project,
    workerId: ids.worker,
    worktreeId: ids.tree,
    path: "notes/" + phase + " 🦀.md",
  };
  const document = {
    id: documentId,
    worktreeId: ids.tree,
    stateProtection: await crypto.encryptSurfacePrivateState({
      ...common,
      componentKey: key("private-surface-metadata"),
      context,
      content: fileContent,
    }),
  };
  return {
    phase,
    project: await label("project", ids.project, text(phase + ":project")),
    chat: await label("chat", ids.chat, text(phase + ":chat")),
    taskLabel: await label("chat", ids.task, text(phase + ":task label")),
    user,
    assistant,
    pending,
    prompt,
    task,
    draft,
    document,
    taskContent,
    draftContent,
    fileContent,
    context,
  };
}
export async function verifyMaterial(material, observed, serverId) {
  const common = { ownerId: ids.owner, keyRevision: 1 };
  assert.equal(
    await crypto.decryptPrivateDisplayLabel({
      ...common,
      recordKind: "chat",
      rowId: ids.chat,
      componentKey: key("private-surface-metadata"),
      opaque: observed.chat.titleProtection,
    }),
    text(material.phase + ":chat"),
  );
  assert.deepEqual(
    await crypto.decryptTaskProtectedContent({
      ...common,
      chatId: ids.task,
      componentKey: key("task-content"),
      encrypted: observed.task.protectedContent,
      publicClassification: classification,
    }),
    material.taskContent,
  );
  assert.deepEqual(
    await crypto.decryptChatComposerDraftProtectedContent({
      ...common,
      chatId: ids.chat,
      componentKey: key("chat-content"),
      encrypted: observed.draft.state.protectedContent,
    }),
    material.draftContent,
  );
  const document = observed.documents.find(
    (d) => d.id === material.document.id,
  );
  assert.ok(document);
  assert.deepEqual(
    await crypto.decryptSurfacePrivateState({
      ...common,
      componentKey: key("private-surface-metadata"),
      context: { ...material.context, serverId },
      opaque: document.stateProtection,
    }),
    material.fileContent,
  );
}
export async function seed(database, material) {
  const insert = async (table, row) => {
    const names = Object.keys(row),
      qs = names.map((_, i) => "$" + (i + 1));
    await database.query(
      `INSERT INTO ${table}(${names.map((s) => '"' + s + '"').join(",")}) VALUES(${qs.join(",")})`,
      Object.values(row).map((v) =>
        v && typeof v === "object" ? JSON.stringify(v) : v,
      ),
    );
  };
  await database.transaction(async (db) => {
    const saved = database;
    database = db;
    try {
      // This is a stopped historical profile with no live worker. Enrollment
      // creates a current presence timestamp; use the historical fixture time
      // before the baseline so its real presence TTL cannot expire mid-compare.
      await db.query("UPDATE workers SET last_seen_at=$1 WHERE id=$2", [
        stamp,
        ids.worker,
      ]);
      await insert("projects", {
        id: ids.project,
        owner_id: ids.owner,
        origin_kind: "managed-folder",
        folder_management: "managed",
        worktree_policy: "direct",
        git_capability: false,
        github_capability: false,
        protected_label: material.project,
        preferred_worker_id: ids.worker,
        task_scheduling_paused: true,
        task_scheduling_paused_at: stamp,
      });
      await insert("project_source_identities", {
        id: ids.source,
        project_id: ids.project,
        worker_id: ids.worker,
        location_kind: "worker-local",
      });
      const handle = "ctrr_" + Buffer.alloc(32, 7).toString("base64url");
      await insert("project_sources", {
        id: ids.source,
        project_id: ids.project,
        worker_id: ids.worker,
        source_kind: "folder",
        absolute_path: handle,
        display_path: handle,
      });
      await insert("project_worktrees", {
        id: ids.tree,
        project_source_id: ids.source,
        worker_id: ids.worker,
        name: "main",
        absolute_path: handle,
        display_path: handle,
        is_primary: true,
        is_default: true,
        origin: "cantrip",
        lifecycle_state: "ready",
        root_kind: "folder-root",
      });
      await insert("project_workspace_memberships", {
        workspace_id: "workspace:default:" + ids.owner,
        project_id: ids.project,
      });
      await insert("model_profiles", {
        id: ids.model,
        owner_id: ids.owner,
        name: "Rollback fixture model",
      });
      for (const [id, experience, protected_label] of [
        [ids.chat, "agent", material.chat],
        [ids.task, "task", material.taskLabel],
      ])
        await insert("chats", {
          id,
          owner_id: ids.owner,
          project_id: ids.project,
          active_worker_id: ids.worker,
          active_worktree_id: ids.tree,
          worktree_mode: "pinned",
          experience,
          protected_label,
          automation_paused: true,
          model_id: ids.model,
          ...(experience === "agent"
            ? {
                protected_composer_draft: material.draft,
                composer_draft_updated_at: stamp,
              }
            : {}),
        });
      for (const message of [
        material.user,
        material.assistant,
        material.pending,
      ])
        await insert("chat_messages", {
          id: message.id,
          chat_id: ids.chat,
          role: message.classification.role,
          idempotency_key: message.idempotencyKey,
          protected_content: message.protectedContent,
          worktree_id: ids.tree,
        });
      await insert("queued_prompts", {
        id: ids.prompt,
        chat_id: ids.chat,
        model_id: ids.model,
        idempotency_key: material.prompt.idempotencyKey,
        worktree_id: ids.tree,
        frozen: true,
        opaque_content: material.prompt,
      });
      await insert("managed_queue_states", {
        chat_id: ids.chat,
        revision: 1,
        notified_revision: 1,
      });
      await insert("tasks", {
        chat_id: ids.task,
        protected_content: material.task.protectedContent,
      });
      await insert("file_documents", {
        id: material.document.id,
        project_id: ids.project,
        worker_id: ids.worker,
        worktree_id: ids.tree,
        protected_state: material.document.stateProtection,
      });
      await insert("native_history_bindings", {
        id: ids.binding,
        owner_id: ids.owner,
        worker_id: ids.worker,
        chat_id: ids.chat,
        thread_id: "rollback-thread",
        project_id: ids.project,
        worktree_id: ids.tree,
      });
      await insert("native_history_streams", {
        id: ids.stream,
        binding_id: ids.binding,
        acknowledged_sequence: 1,
        acknowledged_digest: "a".repeat(64),
      });
      const batch = nativeHistoryPreparedBatchSchema.parse({
        items: [],
        turns: [],
      });
      const receipt = nativeHistoryCommitReceiptSchema.parse({
        committed: true,
        commitId: ids.commit,
        streamId: ids.stream,
        sequence: 1,
        recordId: randomUUID(),
        digest: "a".repeat(64),
      });
      await insert("native_history_receipts", {
        commit_id: ids.commit,
        stream_id: ids.stream,
        sequence: 1,
        record_id: receipt.recordId,
        digest: receipt.digest,
        payload_digest: nativeHistoryPayloadDigest({
          batch,
          previousDigest: null,
        }),
        protected_batch: batch,
      });
      await db.exec(
        `CREATE TABLE public.migration_probe(id serial PRIMARY KEY,content text,metadata jsonb,raw bytea,large_number bigint,precise_number numeric,happened_at timestamptz,values_array text[]);INSERT INTO public.migration_probe(content,metadata,raw,large_number,precise_number,happened_at,values_array) VALUES ('rollback LF\nCRLF\r\n','{"null":null,"integer":9007199254740993}',decode('000102ff','hex'),9007199254740993,123456789012345678901234567890.12345,'2026-11-07T01:02:03.123456Z',ARRAY['NULL',NULL,'quoted"value']);INSERT INTO public.migration_probe(id,content,metadata) VALUES(2,'JSON null','null'::jsonb),(3,'SQL null',NULL);SELECT setval('public.migration_probe_id_seq',101,false);CREATE FUNCTION public.migration_literal_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'rollback é🦀'::text $$;`,
      );
    } finally {
      database = saved;
    }
  });
}
