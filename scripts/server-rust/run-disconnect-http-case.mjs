import assert from "node:assert/strict";
import { request } from "node:http";
import { eventually } from "./full-worker.mjs";

export async function runDisconnectCase({
  fixture,
  worker,
  input,
  send,
  setMode,
}) {
  const start = input("start");
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let reached = false;
  worker.beforeRuntimeResponse = async (command) => {
    if (
      command.type.endsWith(".start") &&
      command.identity.operationId === start.operationId
    ) {
      reached = true;
      await barrier;
      setMode("active");
    }
  };
  const before = worker.runtimeCommands.filter((command) =>
    command.type.endsWith(".start"),
  ).length;
  const client = fixture.client();
  const body = JSON.stringify(start);
  const req = request(
    new URL(
      "/api/run-configuration-runtimes/operations",
      fixture.server.origin,
    ),
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(client.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
    },
  );
  let responseReceived = false;
  req.on("response", (response) => {
    responseReceived = true;
    response.resume();
  });
  let requestError;
  req.on("error", (error) => {
    requestError = error;
  });
  const closed = new Promise((resolve) => req.once("close", resolve));
  req.end(body);
  try {
    await eventually(
      () => reached,
      (value) => assert.equal(value, true),
    );
    // Dispatch proves durable admission. Close the actual HTTP socket while
    // its worker reply is held, then retry only after the close event.
    const interrupted = new Error(
      "Controlled client disconnect after admission",
    );
    req.destroy(interrupted);
    await closed;
    assert.equal(requestError, interrupted);
    assert.equal(responseReceived, false);
    release();
    const replayed = await send("Run disconnected request replay", start);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.operation.id, start.operationId);
    assert.equal(replayed.runtime.state, "running");
    assert.equal(replayed.runtime.requestedOperationId, start.operationId);
    const dispatched =
      worker.runtimeCommands.filter((command) =>
        command.type.endsWith(".start"),
      ).length - before;
    assert.equal(dispatched, 1);
    setMode("exited");
    const stopped = await send(
      "Run disconnected request cleanup stop",
      input("stop"),
      202,
    );
    assert.equal(stopped.runtime.state, "exited");
    assert.equal(stopped.runtime.generation, replayed.runtime.generation);
    return {
      socketClosedBeforeReply: true,
      responseReceived,
      replayed: replayed.replayed,
      startDispatches: dispatched,
    };
  } finally {
    release();
    req.destroy();
    delete worker.beforeRuntimeResponse;
  }
}
