// Unchanged production WorkerConnection; attachment endpoint operations controlled.
import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
export async function attachmentWorker({ f, visit, root, state, id }) {
  const report = {
    ...heartbeat,
    workerId: id,
    name: id + " worker",
    platform: "darwin",
  };
  const code = await visit(
    id + " enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: id + " attachment worker" } },
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
    serverUrl: f.server.origin,
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
        if (!command.type.startsWith("attachment.")) {
          state.background.push({ worker: id, command });
          throw new Error(
            "Unsupported controlled attachment background command " +
              command.type,
          );
        }
        state.commands.push({ worker: id, command });
        if (state.intercept) await state.intercept(id, command);
        if (
          state.failType === command.type &&
          (!state.failWorker || state.failWorker === id)
        )
          throw new Error(
            state.failureMessage ?? "Controlled attachment worker failure",
          );
        const key = id + ":" + command.attachmentId;
        switch (command.type) {
          case "attachment.upload.begin":
            state.uploads.set(key, {
              metadata: command.protectedMetadata,
              sizeBytes: command.sizeBytes,
              chunks: [],
            });
            return { ignoredBegin: true };
          case "attachment.upload.chunk":
            state.uploads.get(key).chunks.push(command.chunk);
            return { ignoredChunk: true };
          case "attachment.upload.complete":
            return (
              state.uploadResult ?? {
                sizeBytes: state.uploads.get(key).sizeBytes,
                verified: true,
              }
            );
          case "attachment.read": {
            const upload = state.uploads.get(key);
            return (
              state.readResult?.(command, upload) ?? {
                sizeBytes: upload.sizeBytes,
                chunk: upload.chunks[command.sequence],
              }
            );
          }
          case "attachment.delete":
            state.uploads.delete(key);
            return { ignoredDelete: true };
          default:
            throw new Error("Unknown attachment command");
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
    async close() {
      clearInterval(timer);
      connection.close();
      await pending;
    },
  };
}
