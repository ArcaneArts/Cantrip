// A genuine blocked context read plus a pong proves early frames were consumed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export async function terminalRelayLocks({ fixture, connect, saved, result }) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 }),
    locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const held = deferred(),
    release = deferred();
  let transaction, probe, pid;
  try {
    transaction = locker.begin(async (sql) => {
      pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
      await sql`LOCK TABLE terminals IN ACCESS EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const at = result.commands.length;
    probe = await connect().open();
    let blocked;
    const end = Date.now() + 10000;
    do {
      blocked =
        await observer`SELECT a.pid,a.query,a.wait_event,l.relation::regclass::text relation FROM pg_stat_activity a INNER JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted WHERE a.datname=current_database() AND ${pid}=ANY(pg_blocking_pids(a.pid)) AND l.relation='terminals'::regclass`;
      if (blocked.length) break;
      assert.ok(
        Date.now() < end,
        "observe actual terminal context read blocked on the table lock",
      );
      await delay(10);
    } while (true);
    probe.send("{", { raw: true, binary: true });
    probe.send({ type: "resize", cols: 125, rows: 32 });
    await probe.ping();
    assert.deepEqual(
      probe.history,
      [],
      "frames consumed before terminal context are ignored",
    );
    assert.equal(
      result.commands.slice(at).some((c) => c.type.startsWith("terminal.")),
      false,
    );
    result.terminalRelayLock = {
      blockedQuery: blocked[0].query,
      relation: blocked[0].relation,
      waitEvent: blocked[0].wait_event,
      pongBeforeUnlock: true,
      earlyFramesIgnored: true,
    };
    release.resolve();
    await transaction;
    assert.deepEqual(await probe.next(), { type: "ready" });
    await saved("frames before locked context completes", probe);
    assert.equal(
      result.commands.slice(at).some((c) => c.type === "terminal.resize"),
      false,
      "pre-context resize is never replayed",
    );
  } finally {
    release.resolve();
    await transaction?.catch(() => {});
    if (probe?.socket.readyState === 1) await probe.close();
    await observer.end();
    await locker.end();
  }
}
