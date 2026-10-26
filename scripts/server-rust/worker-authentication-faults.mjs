// Hold the actual credential row lock to suspend production authentication.
// This exercises real sockets and database operations without server test hooks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { SocketProbe } from "./worker-sockets.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function eventually(read, assertion) {
  const expires = performance.now() + 15000;
  while (true) {
    const value = await read();
    try {
      assertion(value);
      return value;
    } catch (error) {
      if (performance.now() >= expires) throw error;
    }
    await delay(10);
  }
}
export async function workerAuthenticationFaults(
  fixture,
  report = { cases: [] },
) {
  assert.equal(fixture.databaseMode, "postgres");
  const credential = fixture.records.get("re-enrolled").credential;
  const hash = createHash("sha256").update(credential).digest("hex");
  const lockSql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const cases = report.cases;
  async function lastUsed() {
    const rows =
      await observer`SELECT last_used_at FROM worker_credentials WHERE secret_hash=${hash}`;
    assert.equal(rows.length, 1);
    return rows[0].last_used_at.getTime();
  }
  async function locked(label, exercise) {
    // Each fault gets a fresh server process against the same retained database.
    // A lastUsedAt write is not proof that all 32 queued authentications and
    // owner lookups have finished and released their handshake permits.
    if (cases.length) {
      try {
        await fixture.close();
        await fixture.start();
      } catch (error) {
        error.message = `${fixture.kind}/restarting before ${label}: ${error.message}`;
        throw error;
      }
    }
    const held = deferred(),
      release = deferred(),
      active = new Set();
    const transaction = lockSql.begin(async (sql) => {
      const rows =
        await sql`SELECT id FROM worker_credentials WHERE secret_hash=${hash} FOR UPDATE`;
      assert.equal(rows.length, 1);
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    async function pending() {
      const probe = new SocketProbe(fixture, { credential });
      active.add(probe);
      await probe.open();
      const frame = await probe.message();
      assert.equal(frame.kind, "connection");
      assert.equal(frame.state, "pending");
      return probe;
    }
    try {
      await held.promise;
      // Earlier abandoned handshakes may still commit while we wait to acquire
      // the row lock. Take the baseline only once our lock is actually held.
      const before = await lastUsed();
      const result = await exercise({ active, pending });
      assert.equal(
        await lastUsed(),
        before,
        "Authentication must really be blocked by the held database row lock",
      );
      for (const probe of active) {
        await probe.close();
        assert.ok(
          !probe.frames.some((frame) => frame.state === "ready"),
          "A closed authentication socket cannot become ready",
        );
      }
      release.resolve();
      await transaction;
      await eventually(lastUsed, (value) =>
        assert.ok(
          value > before,
          "Authentication must finish and update lastUsedAt after its socket closes",
        ),
      );
      cases.push({
        label,
        ...result,
        blockedUntilRelease: true,
        credentialUsageCompletedAfterClose: true,
      });
    } catch (error) {
      error.message = `${fixture.kind}/${label}: ${error.message}`;
      throw error;
    } finally {
      release.resolve();
      await transaction;
      await Promise.all([...active].map((probe) => probe.close()));
    }
  }
  try {
    await locked(
      "32 authentication slots remain occupied after a pending socket closes",
      async ({ active, pending }) => {
        const probes = [];
        for (let i = 0; i < 32; i++) probes.push(await pending());
        await probes[0].close();
        const excess = new SocketProbe(fixture, { credential });
        active.add(excess);
        await excess.open();
        const closed = await excess.waitClosed();
        assert.deepEqual(closed, {
          code: 1013,
          reason: "Worker authentication capacity is unavailable",
        });
        assert.equal(
          excess.frames.length,
          0,
          "Capacity rejection precedes the pending envelope",
        );
        return { closed, slots: probes.length };
      },
    );
    await locked(
      "1024 buffered authentication messages; next frame rejected",
      async ({ pending }) => {
        const probe = await pending();
        for (let i = 0; i < 1024; i++)
          probe.socket.send(i % 2 ? Buffer.from("x") : "x", {
            binary: Boolean(i % 2),
          });
        await probe.ping();
        assert.equal(probe.closeResult, undefined);
        probe.socket.send("x");
        const closed = await probe.waitClosed();
        assert.deepEqual(closed, {
          code: 1009,
          reason: "Worker authentication buffer exceeded",
        });
        return { closed };
      },
    );
    await locked(
      "8 MiB per authentication socket; next byte rejected",
      async ({ pending }) => {
        const probe = await pending();
        probe.socket.send(Buffer.alloc(8 * 1024 * 1024), { binary: true });
        await probe.ping();
        assert.equal(probe.closeResult, undefined);
        probe.socket.send("x");
        const closed = await probe.waitClosed();
        assert.deepEqual(closed, {
          code: 1009,
          reason: "Worker authentication buffer exceeded",
        });
        return { closed };
      },
    );
    await locked(
      "64 MiB process authentication budget is released on close",
      async ({ active, pending }) => {
        const probes = [],
          payload = Buffer.alloc(8 * 1024 * 1024);
        for (let i = 0; i < 8; i++) {
          const probe = await pending();
          probes.push(probe);
          probe.socket.send(payload, { binary: true });
          await probe.ping();
        }
        const excess = await pending();
        excess.socket.send("x");
        const closed = await excess.waitClosed();
        assert.deepEqual(closed, {
          code: 1013,
          reason: "Worker authentication capacity is unavailable",
        });
        await probes[0].close();
        // Awaiting the close handshake proves the server processed that close.
        const replacement = await pending();
        replacement.socket.send(payload, { binary: true });
        await replacement.ping();
        assert.equal(replacement.closeResult, undefined);
        replacement.socket.send("x");
        const replacementClosed = await replacement.waitClosed();
        assert.deepEqual(replacementClosed, {
          code: 1009,
          reason: "Worker authentication buffer exceeded",
        });
        assert.ok(active.size >= 10);
        return { closed, replacementClosed, acceptedBytes: 64 * 1024 * 1024 };
      },
    );
    await locked(
      "authentication deadline closes socket while database operation remains pending",
      async ({ pending }) => {
        const started = performance.now(),
          probe = await pending();
        const closed = await probe.waitClosed();
        assert.deepEqual(closed, {
          code: 1013,
          reason: "Worker authentication timed out",
        });
        assert.ok(
          performance.now() - started >= 9000,
          "Must exercise the real ten-second deadline",
        );
        return { closed };
      },
    );
    report.passed = true;
    return report;
  } finally {
    await Promise.all([
      lockSql.end({ timeout: 5 }),
      observer.end({ timeout: 5 }),
    ]);
  }
}
