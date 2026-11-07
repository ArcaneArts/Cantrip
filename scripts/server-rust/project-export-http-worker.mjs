// Real WorkerConnection with controlled export operations; no native Codex claim.
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
export async function exportWorker({ fixture: f, visit, root, state }) {
  const report = {
    ...heartbeat,
    workerId: "alpha",
    name: "alpha worker",
    platform: "darwin",
    externalCodexHistory: true,
  };
  const code = await visit(
    "worker enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: "Export worker" } },
  );
  const enrollment = await visit(
    "worker enroll",
    "POST",
    "/api/internal/workers/enroll",
    {
      status: 201,
      client: "worker",
      json: { code: code.code, heartbeat: report },
    },
  );
  const config = {
    dataDirectory: path.join(root, "worker"),
    name: report.name,
    serverUrl: f.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrollment.credential,
    tokenSource: "persisted",
    workerId: "alpha",
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: config.workerId,
  });
  let connection, timer, pending;
  const pulse = async () => {
    if (pending) await pending;
    pending = sendHeartbeat(config, report);
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  const start = async () => {
    let connected = false;
    connection = new WorkerConnection(
      config,
      async (command) => {
        if (command.type === "worktree.observation.configure")
          return { accepted: true, paths: [] };
        if (!command.type.startsWith("project.export.")) {
          state.background.push(command);
          throw new Error(
            "Unsupported controlled export background command " + command.type,
          );
        }
        state.commands.push(command);
        if (state.intercept) await state.intercept(command);
        if (
          state.failType === command.type &&
          (!state.failChat || state.failChat === command.chatId)
        )
          throw new Error(state.failureMessage ?? "Controlled worker failure");
        const key = command.operationId + ":" + command.chatId;
        switch (command.type) {
          case "project.export.target.inspect":
            return (
              state.inspection ?? {
                target: command.target,
                available: true,
                destinationLabel: "~/.codex",
                message: null,
                platform: "worker-inspected-platform",
              }
            );
          case "project.export.chat.begin": {
            const previous = state.uploads.get(key);
            if (previous?.result && state.mode !== "force-upload")
              return { ...previous.result, status: "exported", reused: true };
            if (state.mode === "invalid-begin")
              return { status: "upload", extra: true };
            if (state.mode === "invalid-reuse")
              return {
                status: "exported",
                chatId: command.chatId,
                threadId: "thread",
                destinationLabel: "~/.codex",
                messageCount: 0,
                reused: false,
              };
            state.uploads.set(key, { begin: command, chunks: [] });
            return { status: "upload" };
          }
          case "project.export.chat.chunk": {
            const upload = state.uploads.get(key);
            assert.equal(command.chunkIndex, upload.chunks.length);
            const chunk = Buffer.from(command.data, "base64");
            assert.equal(chunk.toString("base64"), command.data);
            assert.ok(chunk.length > 0 && chunk.length <= 262144);
            upload.chunks.push(chunk);
            return state.mode === "arbitrary-chunk-ack"
              ? { notASchema: [null, "😀"] }
              : null;
          }
          case "project.export.chat.complete": {
            const upload = state.uploads.get(key),
              bytes = Buffer.concat(upload.chunks);
            assert.equal(bytes.length, upload.begin.sizeBytes);
            assert.equal(
              createHash("sha256").update(bytes).digest("hex"),
              upload.begin.transcriptSha256,
            );
            const payload = JSON.parse(bytes.toString());
            assert.equal(payload.kind, "chat-encrypted");
            assert.equal(payload.version, 1);
            assert.deepEqual(payload.attachments, []);
            for (const message of payload.messages) {
              assert.ok(message.protectedContent);
              assert.equal(message.content, undefined);
            }
            state.completed.push({
              chatId: command.chatId,
              operationId: command.operationId,
              bytes: bytes.toString("base64"),
              payload,
              digest: upload.begin.transcriptSha256,
            });
            if (state.mode === "invalid-complete")
              return { chatId: command.chatId, messageCount: -1 };
            upload.result = {
              chatId:
                state.mode === "different-result-chat"
                  ? "worker-returned-chat"
                  : command.chatId,
              threadId: "exported-" + command.chatId,
              destinationLabel: "~/.codex",
              messageCount: payload.messages.length,
              reused: false,
            };
            if (state.mode === "lost-complete-ack")
              throw new Error("Controlled completion acknowledgment lost");
            return upload.result;
          }
          default:
            throw new Error("Unknown export command");
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
    timer = setInterval(() => {
      if (!pending)
        void pulse().catch((error) =>
          state.heartbeatFailures.push(String(error)),
        );
    }, 10000);
    timer.unref();
  };
  await start();
  return {
    start,
    pulse,
    report,
    pauseHeartbeat: () => clearInterval(timer),
    async close() {
      clearInterval(timer);
      connection.close();
      await pending;
    },
  };
}
