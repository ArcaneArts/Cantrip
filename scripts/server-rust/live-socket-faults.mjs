// Suspend the real project authorizer with a PostgreSQL table lock. Transport
// ping and close must keep working while the production repository call waits.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { LiveProbe, deadline } from "./live-sockets.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
export async function liveAuthorizationFault(fixture) {
  assert.equal(fixture.databaseMode, "postgres");
  const lockSql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const locked = Promise.withResolvers(),
    release = Promise.withResolvers();
  const transaction = lockSql.begin(async (sql) => {
    await sql`LOCK TABLE projects IN ACCESS EXCLUSIVE MODE`;
    locked.resolve();
    await release.promise;
  });
  transaction.catch(locked.reject);
  const probe = new LiveProbe(fixture);
  try {
    await probe.open();
    await probe.initialized();
    await locked.promise;
    probe.send({
      type: "subscribe",
      requestId: "blocked-project",
      scopes: [{ kind: "project", projectId: "project-one" }],
    });
    const expires = Date.now() + 15000;
    while (true) {
      const rows =
        await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query ILIKE '%projects%'`;
      if (rows.length) break;
      assert.ok(
        Date.now() < expires,
        "Actual project authorization query must be observed waiting on the held database lock",
      );
      await delay(10);
    }
    const payload = Buffer.from("live project authorization lock barrier");
    const pong = new Promise((resolve, reject) => {
      const received = (bytes) => {
        if (!bytes.equals(payload)) return;
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error("Live socket closed before transport pong"));
      };
      const cleanup = () => {
        probe.socket.off("pong", received);
        probe.socket.off("close", closed);
      };
      probe.socket.on("pong", received);
      probe.socket.once("close", closed);
      probe.socket.ping(payload);
    });
    await deadline(
      pong,
      "transport ping while project authorization is locked",
    );
    await probe.close();
    const waiting =
      await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query ILIKE '%projects%'`;
    assert.ok(
      waiting.length,
      "Transport close completed before the blocked repository operation was released",
    );
    assert.equal(
      probe.history.some((frame) => frame.requestId === "blocked-project"),
      false,
    );
    return {
      label:
        "real database lock does not stall WebSocket ping or close acknowledgment",
      blockedQueryObserved: true,
      closedBeforeDatabaseRelease: true,
    };
  } finally {
    release.resolve();
    await transaction;
    await probe.close();
    await Promise.all([
      lockSql.end({ timeout: 5 }),
      observer.end({ timeout: 5 }),
    ]);
  }
}
