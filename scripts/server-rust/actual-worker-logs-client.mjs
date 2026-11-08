// Existing browser log API/parser -> actual server -> unchanged complete worker.
import assert from "node:assert/strict";
import { serviceLogReadResultSchema } from "../../packages/protocol/dist/index.js";
export async function actualWorkerLogs({
  page,
  fixture,
  workerId,
  result,
  phase,
}) {
  const value = await page.evaluate(
    async ({ workerId, serverUrl }) => {
      const api = await import("/src/lib/api/workers.ts");
      const stream = await import("/src/lib/worker-log-stream.ts");
      const tail = await api.getWorkerServiceLogs(workerId, {
        beforeCursor: Number.MAX_SAFE_INTEGER,
        limit: 2,
        minimumLevel: "trace",
      });
      const older = await api.getWorkerServiceLogs(workerId, {
        beforeCursor: tail.records[0]?.cursor ?? Number.MAX_SAFE_INTEGER,
        limit: 2,
        minimumLevel: "trace",
      });
      const fatal = await api.getWorkerServiceLogs(workerId, {
        limit: 500,
        minimumLevel: "fatal",
      });
      const socket = new WebSocket(
        stream.workerLogStreamWebSocketUrl(
          serverUrl,
          window.location.origin,
          workerId,
          0,
          "trace",
        ),
      );
      const state = (window.workerLogAcceptance = {
        socket,
        frames: [],
        encoded: [],
        closed: null,
        error: null,
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Actual full-worker log stream timed out: " +
                  JSON.stringify({
                    frames: state.frames,
                    closed: state.closed,
                    error: state.error,
                  }),
              ),
            ),
          15000,
        );
        const finish = () => {
          if (
            state.frames.some((f) => f.type === "ready") &&
            state.frames.some((f) => f.type === "batch" && f.records.length > 0)
          ) {
            clearTimeout(timeout);
            resolve();
          }
        };
        socket.addEventListener("message", (event) => {
          try {
            const frame = stream.parseWorkerLogStreamMessage(
              String(event.data),
            );
            state.frames.push(frame);
            state.encoded.push(String(event.data));
            finish();
          } catch (error) {
            state.error = error.message;
            clearTimeout(timeout);
            reject(error);
          }
        });
        socket.addEventListener("error", () => {
          state.error = "Browser worker log WebSocket error";
        });
        socket.addEventListener("close", (event) => {
          state.closed = { code: event.code, reason: event.reason };
          if (!state.frames.some((f) => f.type === "ready")) {
            clearTimeout(timeout);
            reject(
              new Error(
                "Full-worker log stream closed before ready: " +
                  JSON.stringify(state.closed),
              ),
            );
          }
        });
      });
      return {
        tail,
        older,
        fatal,
        frames: state.frames,
        encoded: state.encoded,
      };
    },
    { workerId, serverUrl: fixture.server.origin },
  );
  for (const page of [value.tail, value.older, value.fatal])
    assert.deepEqual(serviceLogReadResultSchema.parse(page), page);
  assert.ok(value.tail.records.length > 0 && value.tail.records.length <= 2);
  assert.ok(value.older.records.length <= 2);
  assert.ok(
    value.older.records.every(
      (record) => record.cursor < value.tail.records[0].cursor,
    ),
  );
  assert.ok(value.fatal.records.every((record) => record.level === "fatal"));
  const ready = value.frames.find((frame) => frame.type === "ready");
  assert.equal(ready.nextCursor, 0);
  assert.match(ready.subscriptionId, /^[0-9a-f-]{36}$/);
  const records = value.frames
    .filter((frame) => frame.type === "batch")
    .flatMap((frame) => frame.records);
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.system === "worker"));
  (result.workerLogs ??= []).push({ phase, ...value });
  result.steps.push(
    phase +
      ": existing browser log API reads bounded history and levels; existing WebSocket URL/parser receives real full-worker replay and startup diagnostics",
  );
}
export async function actualWorkerLogsDisconnected({ page, result, phase }) {
  const value = await page.evaluate(async () => {
    const state = window.workerLogAcceptance;
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        if (state.closed) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(
            new Error("Worker log lease survived actual full-worker stop"),
          );
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
    return {
      closed: state.closed,
      frames: state.frames,
      encoded: state.encoded,
      error: state.error,
    };
  });
  assert.equal(value.error, null);
  assert.deepEqual(value.closed, { code: 1013, reason: "Worker disconnected" });
  assert.ok(
    value.frames.some(
      (frame) => frame.type === "error" && frame.code === "worker-offline",
    ),
  );
  result.workerLogs.push({ phase: phase + " disconnected", ...value });
  result.steps.push(
    phase +
      ": actual full-worker stop emits worker-offline and closes the browser log stream without retaining its lease",
  );
}
