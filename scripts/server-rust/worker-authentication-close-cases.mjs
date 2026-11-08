// Real credential row lock, upgraded socket and production signal handling.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres"),
  WebSocket = require("ws");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, no) => {
        timer = setTimeout(() => no(new Error(label)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function workerAuthenticationCloseCase({
  item,
  child,
  origin,
  credential,
  url,
  completion,
}) {
  const monitor = postgres(url, { max: 1 }),
    locker = postgres(url, { max: 1 });
  const held = deferred(),
    release = deferred();
  let socket, lockPid;
  await monitor.unsafe(`CREATE TABLE cantrip_test_closed_auth_usage (credential_id text NOT NULL);
    CREATE FUNCTION cantrip_test_closed_auth_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO cantrip_test_closed_auth_usage VALUES (NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER cantrip_test_closed_auth_usage AFTER UPDATE OF last_used_at ON worker_credentials
      FOR EACH ROW EXECUTE FUNCTION cantrip_test_closed_auth_usage();`);
  const transaction = locker.begin(async (sql) => {
    lockPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
    const locked =
      await sql`SELECT id FROM worker_credentials WHERE worker_id='alpha' FOR UPDATE`;
    assert.equal(locked.length, 1);
    held.resolve();
    await release.promise;
  });
  transaction.catch(held.reject);
  try {
    await held.promise;
    const pending = deferred(),
      closeReceived = deferred(),
      ended = deferred();
    item.authenticationStates = [];
    socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/api/internal/workers/connect?workerId=alpha&connectionGeneration=${randomUUID()}`,
      ["cantrip-worker-auth-ready-v2"],
      { headers: { authorization: `Bearer ${credential}` } },
    );
    socket.on("error", (error) => {
      item.socketError = error.message;
    });
    socket.once("close", (code, reason) =>
      ended.resolve({ code, reason: reason.toString() }),
    );
    socket.on("message", (bytes) => {
      const envelope = JSON.parse(bytes.toString());
      item.authenticationStates.push(envelope.state);
      if (envelope.state === "pending") pending.resolve();
    });
    const realClose = socket.close.bind(socket);
    socket.close = (code, reason) => {
      item.closeFrame = {
        code: code ?? 1005,
        reason: reason?.toString() ?? "",
      };
      closeReceived.resolve();
    };
    await within(pending.promise, "actual pending-authentication frame");
    const deadline = Date.now() + 15000;
    for (;;) {
      item.blockedAuthentication =
        await monitor`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND ${lockPid} = ANY(pg_blocking_pids(pid))`;
      if (item.blockedAuthentication.length) break;
      assert.ok(
        Date.now() < deadline,
        "actual credential authentication waits on row lock",
      );
      await delay(10);
    }
    child.kill("SIGTERM");
    await within(
      closeReceived.promise,
      "production shutdown CLOSE during blocked authentication",
    );
    await delay(150);
    item.heldAuthentication = {
      processAlive: child.exitCode === null,
      tcpEnded: socket._socket.readableEnded,
    };
    assert.deepEqual(item.closeFrame, { code: 1005, reason: "" });
    assert.deepEqual(
      item.heldAuthentication,
      { processAlive: true, tcpEnded: false },
      "pending authentication retains the actual close handshake",
    );
    realClose();
    item.socketClosed = await within(
      ended.promise,
      "pending-authentication peer ACK/TCP completion",
    );
    assert.deepEqual(item.socketClosed, item.closeFrame);
    await delay(150);
    assert.equal(
      child.exitCode,
      null,
      "closed socket must not release database authentication ownership",
    );
    release.resolve();
    await transaction;
    item.exit = await within(
      completion,
      "authentication side effects drain before shutdown",
    );
    assert.deepEqual(item.exit, { code: 0, signal: null });
    assert.deepEqual(item.authenticationStates, ["pending"]);
    item.committedUsage = Number(
      (
        await monitor`SELECT count(*) AS count FROM cantrip_test_closed_auth_usage`
      )[0].count,
    );
    assert.equal(
      item.committedUsage,
      1,
      "original closed-socket credential usage commits exactly once",
    );
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    release.resolve();
    await transaction;
    await locker.end({ timeout: 5 });
    await monitor.end({ timeout: 5 });
  }
}

export async function rejectedWorkerAuthenticationCloseCase({
  item,
  child,
  origin,
  completion,
}) {
  const closeReceived = deferred(),
    ended = deferred();
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/api/internal/workers/connect?workerId=alpha&connectionGeneration=${randomUUID()}`,
    ["cantrip-worker-auth-ready-v2"],
    { headers: { authorization: `Bearer ctwk_${"Z".repeat(43)}` } },
  );
  socket.on("error", (error) => {
    item.socketError = error.message;
  });
  socket.once("close", (code, reason) =>
    ended.resolve({ code, reason: reason.toString() }),
  );
  const realClose = socket.close.bind(socket);
  socket.close = (code, reason) => {
    item.closeFrame = { code: code ?? 1005, reason: reason?.toString() ?? "" };
    closeReceived.resolve();
  };
  try {
    await within(closeReceived.promise, "actual rejected credential CLOSE");
    await delay(150);
    item.heldRejectedAuthentication = {
      processAlive: child.exitCode === null,
      tcpEnded: socket._socket.readableEnded,
    };
    assert.deepEqual(item.closeFrame, { code: 1008, reason: "Unauthorized" });
    assert.deepEqual(
      item.heldRejectedAuthentication,
      { processAlive: true, tcpEnded: false },
      "rejected authentication retains its close acknowledgment handshake",
    );
    realClose(item.closeFrame.code, item.closeFrame.reason);
    item.socketClosed = await within(
      ended.promise,
      "rejected-authentication peer ACK",
    );
    assert.deepEqual(item.socketClosed, item.closeFrame);
    child.kill("SIGTERM");
    item.exit = await within(
      completion,
      "shutdown after rejected credential cleanup",
    );
    assert.deepEqual(item.exit, { code: 0, signal: null });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}
