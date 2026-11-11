// Real WorkerConnection and endpoint crypto with controlled external file and runtime inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { chatImportAttachmentId } from "../../tests/reference-node-server/src/db/chat-import-jobs.ts";
import { externalChatTranscriptSchema } from "../../packages/protocol/dist/external-chat-imports.js";
import { heartbeat } from "./security-fixtures.mjs";
import { label, stamp } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
export const sourceId = "a".repeat(64);
const required = [
  "thread/start",
  "thread/read",
  "thread/inject_items",
  "thread/unsubscribe",
  "skills/list",
  "permissionProfile/list",
  "collaborationMode/list",
  "thread/settings/update",
];
export function importWorkerState() {
  return {
    mode: "success",
    commands: [],
    background: [],
    snapshots: new Map(),
    uploads: [],
    attachmentUploads: new Map(),
    chunks: new Map(),
    descriptors: new Map(),
    nextThread: 0,
  };
}
function metadata(thread = "external-thread") {
  return {
    sourceThreadId: thread,
    title: "External title 😀",
    preview: "External preview",
    cwd: "/fixture/github-alpha",
    createdAt: stamp,
    updatedAt: stamp,
    archived: false,
    source: "vscode",
    status: "not-loaded",
    modelProvider: "openai",
    cliVersion: "0.149.0",
    git: null,
    match: {
      kind: "worktree-path",
      projectReplicaId: "github-alpha",
      worktreeId: "github-alpha-main",
    },
    existingImport: null,
  };
}
export async function importWorker({ fixture, visit, root, id, state, owner }) {
  const report = {
    ...heartbeat,
    workerId: id,
    name: id + " worker",
    platform: "darwin",
    externalCodexHistory: true,
    codexRuntime: {
      ...heartbeat.codexRuntime,
      compatibility: "compatible",
      methods: Object.fromEntries(required.map((k) => [k, "available"])),
      degradedReasons: [],
    },
  };
  const code = await visit(
    id + " enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: id } },
  );
  const enrollment = await visit(
    id + " enroll",
    "POST",
    "/api/internal/workers/enroll",
    {
      status: 201,
      client: "worker",
      json: { code: code.code, heartbeat: report },
    },
  );
  const config = {
    dataDirectory: path.join(root, id),
    name: report.name,
    serverUrl: fixture.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrollment.credential,
    tokenSource: "persisted",
    workerId: id,
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: id,
  });
  let connection;
  let heartbeatTimer, heartbeatInFlight;
  const pulse = async () => {
    if (heartbeatInFlight) await heartbeatInFlight;
    const pending = sendHeartbeat(config, report);
    heartbeatInFlight = pending;
    try {
      return await pending;
    } finally {
      if (heartbeatInFlight === pending) heartbeatInFlight = undefined;
    }
  };
  const start = async () => {
    let connected = false;
    connection = new WorkerConnection(
      config,
      async (command) => {
        if (command.type === "worktree.observation.configure")
          return { accepted: true, paths: [] };
        const relevant =
          command.type.startsWith("external.chat-history.") ||
          command.type.startsWith("chat.relocation.hydration.") ||
          command.type === "chat.messages.protect" ||
          command.type === "chat.sync" ||
          command.type.startsWith("attachment.");
        if (!relevant) {
          state.background.push({ worker: id, command });
          throw new Error(
            "Unsupported controlled import background command " + command.type,
          );
        }
        state.commands.push({ worker: id, command });
        if (state.failCommand === command.type)
          throw new Error(
            state.failureMessage ?? "Controlled import worker failure",
          );
        switch (command.type) {
          case "external.chat-history.discover": {
            if (state.mode === "discovery-invalid")
              return { sources: [{}], truncated: false };
            if (state.mode === "discovery-error")
              throw new Error("Controlled discovery error");
            if (state.mode === "discovery-timeout")
              throw new Error("Controlled discovery timed out");
            const thread = {
              ...metadata(state.discoveryThread),
              existingImport: {
                jobId: "66666666-6666-4666-8666-666666666666",
                projectId: "worker-spoof",
                chatId: "worker-spoof",
                state: "succeeded",
              },
            };
            return {
              sources: [
                {
                  kind: "chatgpt-codex",
                  sourceId,
                  name: "Local Codex",
                  platform: "darwin",
                  homeLabel: "External home",
                  availability:
                    state.mode === "source-unavailable"
                      ? "unavailable"
                      : "available",
                  message: null,
                  runtimeVersion: "0.149.0",
                  threads: [thread],
                  truncated: state.mode === "source-truncated",
                },
              ],
              truncated: state.mode === "worker-truncated-only",
            };
          }
          case "external.chat-history.read": {
            assert.equal(command.ownerId, owner);
            if (state.readBarrier) await state.readBarrier;
            if (state.mode === "read-error")
              throw new Error(
                state.failureMessage ?? "Controlled external read failure",
              );
            if (state.mode === "invalid-transcript") return { transcript: {} };
            const descriptors = state.withAttachments
              ? await Promise.all(
                  [0, 1, 2].map(async (n) => {
                    const sourceAttachmentId = createHash("sha256")
                      .update("external-attachment-" + n)
                      .digest("hex");
                    const attachmentId = chatImportAttachmentId(
                      command.chatId,
                      sourceAttachmentId,
                    );
                    const status = ["available", "missing", "unsupported"][n];
                    const descriptor = {
                      id: attachmentId,
                      sourceAttachmentId,
                      itemId: "user-0",
                      sizeBytes: n === 0 ? 300001 : 128,
                      status,
                      protectedMetadata: await state.crypto.protectMetadata(
                        command.chatId,
                        attachmentId,
                        n,
                        status,
                      ),
                    };
                    state.descriptors.set(sourceAttachmentId, descriptor);
                    return descriptor;
                  }),
                )
              : [];
            const count = state.messageCount ?? 2;
            const transcript = externalChatTranscriptSchema.parse({
              sourceId: command.sourceId,
              sourceThreadId: command.sourceThreadId,
              titleProtection: label("chat"),
              metadata: metadata(command.sourceThreadId),
              sync: {
                threadId: command.sourceThreadId,
                status: "idle",
                turns: [
                  {
                    id: "external-turn",
                    status: "completed",
                    startedAt: 1786800000,
                    completedAt: 1786800010,
                    durationMs: 10000,
                    items: Array.from({ length: count }, (_, n) => ({
                      type: "userMessage",
                      id: "user-" + n,
                      text: "Imported message 😀 \ud800 \u2028 " + n,
                      externalAttachmentIds:
                        n === 0 ? descriptors.map((d) => d.id) : [],
                    })),
                  },
                ],
              },
              attachments: descriptors,
            });
            if (state.mode === "changed-identity")
              transcript.sourceThreadId = "changed";
            if (state.mode === "invalid-attachment-reference")
              transcript.attachments[0].itemId = "wrong";
            return { transcript };
          }
          case "chat.messages.protect": {
            if (state.protectBarrier) await state.protectBarrier;
            const replies = await state.crypto.protectMessages(command);
            if (state.mode === "protect-truncated") replies.pop();
            if (state.mode === "protect-wrong-key" && replies[0])
              replies[0].idempotencyKey = "wrong";
            return replies;
          }
          case "external.chat-history.attachment.read": {
            assert.equal(command.ownerId, owner);
            const descriptor = state.descriptors.get(command.attachmentId);
            assert.equal(command.targetAttachmentId, descriptor.id);
            if (state.mode === "attachment-unavailable")
              return { status: "unavailable", reasonCode: "missing" };
            const count = Math.min(
              command.limit,
              descriptor.sizeBytes - command.offset,
            );
            const sequence =
              command.sequence +
              (state.mode === "attachment-wrong-sequence" ? 1 : 0);
            const eof =
              state.mode === "attachment-early-eof" ||
              (state.mode !== "attachment-unterminated" &&
                command.offset + count === descriptor.sizeBytes);
            let chunk = await state.crypto.protectChunk(
              { ...command, sequence },
              count,
              eof,
            );
            if (state.mode === "attachment-authentication-failure")
              chunk = state.crypto.tamperChunk(chunk);
            state.chunks.set(
              command.operationId + ":" + command.sequence,
              structuredClone(chunk),
            );
            return {
              status: "available",
              sizeBytes:
                descriptor.sizeBytes +
                (state.mode === "attachment-size-changed" ? 1 : 0),
              chunk,
            };
          }
          case "external.chat-history.attachments.release":
            if (state.mode === "release-error")
              throw new Error("Controlled external release failure");
            return null;
          case "attachment.upload.begin": {
            const metadata = await state.crypto.openMetadata(command);
            assert.equal(metadata.error, null);
            assert.equal(metadata.sha256, state.crypto.fileDigest);
            state.attachmentUploads.set(command.operationId, {
              attachmentId: command.attachmentId,
              sizeBytes: command.sizeBytes,
              chunks: [],
              hash: createHash("sha256"),
            });
            return null;
          }
          case "attachment.upload.chunk": {
            const upload = state.attachmentUploads.get(command.operationId);
            upload.chunks.push(command.chunk);
            assert.deepEqual(
              command.chunk,
              state.chunks.get(
                command.operationId + ":" + command.chunk.sequence,
              ),
              "Ciphertext and authenticated chunk fields remain identical",
            );
            upload.hash.update(await state.crypto.openChunk(command));
            return null;
          }
          case "attachment.upload.complete": {
            const upload = state.attachmentUploads.get(command.operationId);
            assert.equal(
              upload.chunks.reduce((n, c) => n + c.plaintextBytes, 0),
              upload.sizeBytes,
            );
            assert.equal(upload.chunks.at(-1).eof, true);
            upload.digest ??= upload.hash.digest("hex");
            assert.equal(upload.digest, state.crypto.fileDigest);
            return {
              sizeBytes:
                upload.sizeBytes +
                (state.mode === "attachment-size-unverified" ? 1 : 0),
              verified: state.mode !== "attachment-unverified",
            };
          }
          case "attachment.delete":
            for (const [operation, upload] of state.attachmentUploads)
              if (upload.attachmentId === command.attachmentId)
                state.attachmentUploads.delete(operation);
            return null;
          case "chat.relocation.hydration.begin": {
            if (state.beginBarrier) await state.beginBarrier;
            const previous = state.snapshots.get(command.snapshotId);
            if (previous?.threadId)
              return { status: "hydrated", threadId: previous.threadId };
            state.snapshots.set(command.snapshotId, {
              begin: command,
              chunks: [],
            });
            return { status: "upload" };
          }
          case "chat.relocation.hydration.chunk": {
            const snapshot = state.snapshots.get(command.snapshotId);
            assert.equal(command.chunkIndex, snapshot.chunks.length);
            const chunk = Buffer.from(command.data, "base64");
            assert.ok(chunk.length <= 262144);
            snapshot.chunks.push(chunk);
            return null;
          }
          case "chat.relocation.hydration.complete": {
            if (state.hydrationBarrier) await state.hydrationBarrier;
            const snapshot = state.snapshots.get(command.snapshotId),
              bytes = Buffer.concat(snapshot.chunks);
            assert.equal(bytes.length, snapshot.begin.sizeBytes);
            assert.equal(
              createHash("sha256").update(bytes).digest("hex"),
              snapshot.begin.transcriptSha256,
            );
            const payload = JSON.parse(bytes.toString());
            assert.equal(payload.kind, "chat-encrypted");
            for (const m of payload.messages) {
              await state.crypto.reopenMessage(m);
              assert.equal(m.content, undefined);
            }
            for (const { attachment } of payload.attachments)
              await state.crypto.reopenAttachment(attachment);
            state.uploads.push({
              snapshotId: command.snapshotId,
              bytes: bytes.toString("base64"),
              payload,
            });
            snapshot.threadId = "imported-thread-" + state.nextThread++;
            return {
              snapshotId: command.snapshotId,
              transcriptSha256:
                state.mode === "wrong-digest"
                  ? "f".repeat(64)
                  : snapshot.begin.transcriptSha256,
              threadId: snapshot.threadId,
              reused: false,
            };
          }
          case "chat.sync":
            return {
              threadId:
                state.mode === "wrong-sync-thread"
                  ? "wrong-thread"
                  : command.threadId,
              status: "idle",
              turns: [],
            };
          default:
            throw new Error("Unhandled import command " + command.type);
        }
      },
      undefined,
      undefined,
      undefined,
      1000,
      () => {
        connected = true;
      },
    );
    connection.start();
    await eventually(
      () => connected,
      (v) => assert.equal(v, true),
    );
    await pulse();
    heartbeatTimer = setInterval(() => {
      if (!heartbeatInFlight)
        void pulse().catch((error) => {
          state.heartbeatFailures ??= [];
          state.heartbeatFailures.push(String(error));
        });
    }, 10000);
    heartbeatTimer.unref();
  };
  await start();
  return {
    start,
    close: async () => {
      clearInterval(heartbeatTimer);
      connection.close();
      await heartbeatInFlight;
    },
    heartbeat: report,
    pulse,
  };
}
