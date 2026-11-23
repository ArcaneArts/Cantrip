// Existing browser log API/parser -> actual server -> unchanged complete worker.
import assert from "node:assert/strict";
import { serviceLogReadResultSchema } from "../../packages/protocol/dist/index.js";
export async function actualWorkerLogs({
  page,
  fixture,
  workerId,
  result,
  phase,
  recoveringWorker,
}) {
  const value = await page.evaluate(
    async ({ workerId, serverUrl, recoverAfterRedisRestart }) => {
      const api = await import("/src/lib/api/workers.ts");
      const { CantripApiError } = await import("/src/lib/api-client.ts");
      const stream = await import("/src/lib/worker-log-stream.ts");
      const firstRead = () =>
        api.getWorkerServiceLogs(workerId, {
          beforeCursor: Number.MAX_SAFE_INTEGER,
          limit: 2,
          minimumLevel: "trace",
        });
      const recovery = [];
      const started = performance.now();
      let tail;
      for (;;) {
        try {
          tail = await firstRead();
          if (recoverAfterRedisRestart) {
            recovery.push({
              status: 200,
              elapsedMs: performance.now() - started,
            });
          }
          break;
        } catch (error) {
          if (
            !recoverAfterRedisRestart ||
            !(error instanceof CantripApiError) ||
            error.status !== 503 ||
            !["Worker is unavailable.", "Worker is offline."].includes(
              error.message,
            )
          )
            throw error;
          const elapsedMs = performance.now() - started;
          recovery.push({
            status: error.status,
            message: error.message,
            elapsedMs,
          });
          if (elapsedMs >= 30_000) {
            throw new Error(
              "Worker log read did not recover after Redis restarted: " +
                JSON.stringify(recovery),
              { cause: error },
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
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
        ...(recoverAfterRedisRestart ? { recovery } : {}),
      };
    },
    {
      workerId,
      serverUrl: fixture.server.origin,
      recoverAfterRedisRestart: Boolean(recoveringWorker),
    },
  );
  if (recoveringWorker) {
    assert.equal(recoveringWorker.exitCode, null);
    assert.equal(recoveringWorker.signalCode, null);
    assert.ok(value.recovery.at(-1).elapsedMs < 30_000);
    value.recoveryWorkerPid = recoveringWorker.pid;
  }
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
