// Production WorkerConnection and protocol decoder; operation outcomes are controlled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";

export const revision = "a".repeat(40);
const methods = [
  "thread/start",
  "thread/inject_items",
  "thread/unsubscribe",
  "skills/list",
  "permissionProfile/list",
  "collaborationMode/list",
  "thread/settings/update",
];
export function relocationWorkerState() {
  return {
    mode: "success",
    commands: [],
    background: [],
    heads: { alpha: revision, beta: revision },
    snapshots: new Map(),
    uploads: [],
    attachmentSizes: {},
    attachmentUploads: new Map(),
    readChunks: new Map(),
    nextThread: 0,
    statusCounts: { alpha: 0, beta: 0 },
  };
}
export async function relocationWorker({ fixture, visit, root, id, state }) {
  const report = {
    ...heartbeat,
    workerId: id,
    name: id + " worker",
    chatRelocation: true,
    codexRuntime: {
      ...heartbeat.codexRuntime,
      compatibility: "compatible",
      methods: Object.fromEntries(
        methods.map((method) => [method, "available"]),
      ),
      degradedReasons: [],
    },
    projectReplicas: {
      ...heartbeat.projectReplicas,
      provision: true,
      synchronize: true,
      remove: true,
      exactRevision: true,
      workspaceScopedRoots: true,
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
  const start = async () => {
    let connected = false;
    connection = new WorkerConnection(
      config,
      async (command) => {
        if (command.type === "worktree.observation.configure")
          return { accepted: true, paths: [] };
        if (
          !["worktree.status", "project.replica.synchronize"].includes(
            command.type,
          ) &&
          !command.type.startsWith("chat.relocation.") &&
          !command.type.startsWith("attachment.")
        ) {
          state.background.push({ worker: id, command });
          throw new Error(
            "Unsupported controlled background command " + command.type,
          );
        }
        state.commands.push({ worker: id, command });
        if (state.failCommand === command.type)
          throw new Error("Controlled relocation worker failure");
        if (state.closeOn === command.type) {
          state.closeOn = null;
          connection.close();
          return null;
        }
        switch (command.type) {
          case "worktree.status": {
            state.statusCounts[id]++;
            const dirty =
              (state.mode === "source-dirty" && id === "alpha") ||
              (state.mode === "target-dirty" && id === "beta") ||
              (state.mode === "target-became-dirty" &&
                id === "beta" &&
                state.statusCounts[id] >= 2);
            const head = state.heads[id];
            return {
              worktree: {
                path: command.worktreePath,
                head,
                branch: "main",
                detached: false,
                isPrimary: true,
                managed: true,
                locked: false,
                lockReason: null,
                prunable: false,
                pruneReason: null,
                missing: false,
              },
              status: {
                branch: "main",
                head,
                upstream: null,
                ahead: 0,
                behind: 0,
                branches: [],
                files: dirty
                  ? [
                      {
                        path: "dirty.txt",
                        originalPath: null,
                        indexStatus: " ",
                        worktreeStatus: "M",
                        staged: false,
                        unstaged: true,
                      },
                    ]
                  : [],
              },
            };
          }
          case "project.replica.synchronize": {
            if (state.mode === "replica-sync-fails")
              throw new Error("Controlled replica synchronization failure");
            const previous = state.heads[id];
            if (state.mode !== "replica-sync-wrong-head")
              state.heads[id] = command.expectedRevision;
            return {
              status: "ready",
              jobId: command.jobId,
              attempt: command.attempt,
              path: command.sourcePath,
              previousRevision: previous,
              resolvedRevision: command.expectedRevision,
              branch: "main",
              changed: previous !== command.expectedRevision,
            };
          }
          case "chat.relocation.hydration.begin": {
            const existing = state.snapshots.get(command.snapshotId);
            if (existing?.threadId) {
              const response = {
                status: "hydrated",
                threadId: existing.threadId,
              };
              if (state.reusedHydrationBarrier)
                await state.reusedHydrationBarrier;
              return response;
            }
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
            assert.ok(
              ["chat-encrypted", "task-encrypted"].includes(payload.kind),
            );
            for (const message of payload.messages) {
              assert.ok(message.protectedContent);
              assert.equal(message.content, undefined);
            }
            state.uploads.push({
              snapshotId: command.snapshotId,
              bytes: bytes.toString("base64"),
              payload,
            });
            snapshot.threadId = state.concurrentThreads
              ? "concurrent-thread-" + snapshot.begin.chatId
              : "relocated-thread-" + state.nextThread++;
            if (state.mode === "stale-commit")
              await fixture.sql([
                "UPDATE chats SET placement_revision=placement_revision+1 WHERE id='chat'",
              ]);
            const response = {
              snapshotId: command.snapshotId,
              transcriptSha256:
                state.mode === "wrong-digest"
                  ? "f".repeat(64)
                  : snapshot.begin.transcriptSha256,
              threadId: snapshot.threadId,
              reused: false,
            };
            if (state.hydrationReplyBarrier) await state.hydrationReplyBarrier;
            return response;
          }
          case "chat.relocation.thread.release":
            if (state.mode === "source-cleanup-fails" && !command.discard)
              throw new Error("Controlled source cleanup failure");
            if (command.discard)
              for (const snapshot of state.snapshots.values())
                if (snapshot.threadId === command.threadId)
                  delete snapshot.threadId;
            return null;
          case "attachment.upload.begin":
            state.attachmentUploads.set(command.operationId, {
              attachmentId: command.attachmentId,
              sizeBytes: command.sizeBytes,
              chunks: [],
            });
            return null;
          case "attachment.read": {
            if (
              state.mode === "attachment-read-fails" &&
              command.sequence === 1
            )
              throw new Error("Controlled attachment read failure");
            const size = state.attachmentSizes[command.attachmentId];
            assert.ok(Number.isSafeInteger(size));
            const count = Math.min(command.limit, size - command.offset);
            const chunk = {
              sequence: command.sequence,
              plaintextBytes: count,
              eof: command.offset + count === size,
              envelope: {
                version: 1,
                algorithm: "AES-256-GCM",
                keyRevision: 1,
                nonce: Buffer.alloc(12, command.sequence).toString("base64url"),
                ciphertext: Buffer.alloc(
                  count + 16,
                  command.sequence + 1,
                ).toString("base64url"),
              },
            };
            if (state.mode === "attachment-wrong-sequence") chunk.sequence++;
            if (state.mode === "attachment-early-eof") chunk.eof = true;
            if (state.mode === "attachment-unterminated") chunk.eof = false;
            state.readChunks.set(
              command.operationId + ":" + command.sequence,
              structuredClone(chunk),
            );
            return {
              sizeBytes:
                state.mode === "attachment-size-changed" ? size + 1 : size,
              chunk,
            };
          }
          case "attachment.upload.chunk": {
            const upload = state.attachmentUploads.get(command.operationId);
            assert.equal(upload.chunks.length, command.chunk.sequence);
            upload.chunks.push(command.chunk);
            assert.deepEqual(
              command.chunk,
              state.readChunks.get(
                command.operationId + ":" + command.chunk.sequence,
              ),
              "Relay preserves every ciphertext byte and authenticated chunk field",
            );
            return null;
          }
          case "attachment.upload.complete": {
            const upload = state.attachmentUploads.get(command.operationId);
            assert.equal(
              upload.chunks.reduce(
                (sum, chunk) => sum + chunk.plaintextBytes,
                0,
              ),
              upload.sizeBytes,
            );
            assert.equal(upload.chunks.at(-1).eof, true);
            return {
              verified: state.mode !== "attachment-unverified",
              sizeBytes: upload.sizeBytes,
            };
          }
          case "attachment.delete":
            for (const [operation, upload] of state.attachmentUploads)
              if (upload.attachmentId === command.attachmentId)
                state.attachmentUploads.delete(operation);
            return null;
          default:
            throw new Error(
              "Unimplemented controlled relocation command " + command.type,
            );
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
      (value) => assert.equal(value, true),
    );
    await sendHeartbeat(config, report);
  };
  await start();
  return { start, close: () => connection.close(), heartbeat: report };
}
