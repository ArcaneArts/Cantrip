// A real quota INSERT waits in PostgreSQL while the server begins shutdown.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
import { LiveProbe } from "./live-sockets.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function catalogRefreshShutdown({
  f,
  server,
  result,
  account,
  reconnect,
}) {
  assert.ok(
    f.environment.DATABASE_URL,
    "Use only fixture-owned external PostgreSQL",
  );
  const monitor = postgres(f.environment.DATABASE_URL, { max: 1 });
  const blocker = postgres(f.environment.DATABASE_URL, { max: 1 });
  const lockId = 19384766;
  let acquired, failed, release, held, closing, live;
  const ready = new Promise((yes, no) => {
    acquired = yes;
    failed = no;
  });
  const unlock = new Promise((yes) => {
    release = yes;
  });
  const counts = async () =>
    Number(
      (
        await monitor.unsafe(
          `SELECT count(*) AS count FROM provider_quota_observations WHERE provider_account_id=${literal(account)}`,
        )
      )[0].count,
    );
  const blocked = async () =>
    Number(
      (
        await monitor.unsafe(
          `SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND objid=${lockId} AND classid=0 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
        )
      )[0].count,
    );
  try {
    live = new LiveProbe(f);
    await live.open();
    await live.initialized();
    await live.subscribed("refresh shutdown observer");
    const before = await counts();
    await f.sql([
      `CREATE FUNCTION owned_catalog_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_account_id=${literal(account)} THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`,
      "CREATE TRIGGER owned_catalog_block BEFORE INSERT ON provider_quota_observations FOR EACH ROW EXECUTE FUNCTION owned_catalog_block_insert()",
    ]);
    held = blocker.begin(async (sql) => {
      await sql.unsafe(`SELECT pg_advisory_xact_lock(${lockId})`);
      acquired();
      await unlock;
    });
    held.catch(failed);
    await ready;
    await reconnect();
    await eventually(blocked, (count) =>
      assert.ok(count >= 1, "Actual reconnect quota INSERT is blocked"),
    );
    closing = f.close();
    closing.catch(() => {});
    result.shutdownSocket = await live.waitClosed();
    if (f.kind === "rust")
      await eventually(
        async () => server.events,
        (events) =>
          assert.ok(
            events.some(
              (event) =>
                event.event === "server.shutdown.stage" &&
                event.stage === "provider-accounts" &&
                event.phase === "started",
            ),
          ),
      );
    assert.equal(server.child.exitCode, null);
    assert.ok((await blocked()) >= 1);
    assert.equal(await counts(), before);
    release();
    await held;
    await closing;
    const after = await counts();
    result.shutdown = {
      before,
      after,
      expected: before + 2,
      exit: { code: server.child.exitCode, signal: server.child.signalCode },
    };
    assert.equal(
      after,
      before + 2,
      "Started refresh persists both quota windows before database close",
    );
    assert.equal(server.child.exitCode, 0);
  } finally {
    release();
    await held?.catch(() => {});
    await live?.close();
    await closing?.catch(() => {});
    try {
      await monitor.unsafe(
        "DROP TRIGGER IF EXISTS owned_catalog_block ON provider_quota_observations",
      );
      await monitor.unsafe(
        "DROP FUNCTION IF EXISTS owned_catalog_block_insert()",
      );
    } finally {
      await Promise.all([
        monitor.end({ timeout: 5 }),
        blocker.end({ timeout: 5 }),
      ]);
    }
  }
}
