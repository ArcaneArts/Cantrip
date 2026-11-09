// Hold an actual timer UPDATE while the production lifecycle begins shutdown.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
import { LiveProbe } from "./live-sockets.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function interactionExpiryShutdown({
  f,
  server,
  result,
  requestId,
  insert,
}) {
  assert.ok(
    f.environment.DATABASE_URL,
    "Use only the fixture-owned external PostgreSQL connection",
  );
  const monitor = postgres(f.environment.DATABASE_URL, { max: 1 }),
    blocker = postgres(f.environment.DATABASE_URL, { max: 1 });
  let acquired, failedAcquisition, release, closing, shutdownLive;
  const ready = new Promise((resolve, reject) => {
      acquired = resolve;
      failedAcquisition = reject;
    }),
    unlock = new Promise((resolve) => {
      release = resolve;
    });
  const lockId = 19384765;
  let held;
  try {
    shutdownLive = new LiveProbe(f);
    await shutdownLive.open();
    await shutdownLive.initialized();
    await shutdownLive.subscribed("expiry shutdown observer");
    await f.sql([
      `CREATE FUNCTION owned_expiry_block_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(requestId)} THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`,
      "CREATE TRIGGER owned_expiry_block BEFORE UPDATE ON agent_interaction_requests FOR EACH ROW EXECUTE FUNCTION owned_expiry_block_update()",
      "UPDATE chats SET status='waiting-for-approval' WHERE id='chat'",
    ]);
    held = blocker.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(${lockId})`);
      acquired();
      await unlock;
    });
    held.catch(failedAcquisition);
    await ready;
    await f.sql([insert]);
    const blocked = async () =>
      Number(
        (
          await monitor.unsafe(
            `SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND objid=${lockId} AND classid=0 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
          )
        )[0].count,
      );
    await eventually(
      blocked,
      (count) =>
        assert.ok(count >= 1, "Actual expiry UPDATE is blocked in PostgreSQL"),
      15000,
    );
    closing = f.close();
    closing.catch(() => {});
    result.shutdownSocket = await shutdownLive.waitClosed();
    if (f.kind === "rust")
      await eventually(
        async () => server.events,
        (events) =>
          assert.ok(
            events.some(
              (event) =>
                event.event === "server.shutdown.stage" &&
                event.stage === "worker-maintenance" &&
                event.phase === "started",
            ),
            "Actual native shutdown reached its owned-operation drain",
          ),
        15000,
      );
    assert.equal(
      server.child.exitCode,
      null,
      "Process remains alive while its actual UPDATE is held",
    );
    assert.ok(
      (await blocked()) >= 1,
      "Started UPDATE survives shutdown admission closure",
    );
    assert.equal(
      (
        await monitor.unsafe(
          `SELECT status FROM agent_interaction_requests WHERE id=${literal(requestId)}`,
        )
      )[0].status,
      "pending",
    );
    release();
    await held;
    await closing;
    const saved = (
      await monitor.unsafe(
        `SELECT r.status,r.resolved_at IS NOT NULL AS resolved,c.status AS chat_status FROM agent_interaction_requests r JOIN chats c ON c.id=r.chat_id WHERE r.id=${literal(requestId)}`,
      )
    )[0];
    result.shutdown = {
      startedUpdateSurvivesShutdown: true,
      saved: { ...saved },
      exit: { code: server.child.exitCode, signal: server.child.signalCode },
    };
    assert.equal(saved.status, "expired");
    assert.equal(saved.resolved, true);
    assert.notEqual(
      saved.chat_status,
      "waiting-for-approval",
      "Started expiry finishes its Chat restoration before database shutdown",
    );
    assert.equal(server.child.exitCode, 0);
  } finally {
    release();
    await held?.catch(() => {});
    await shutdownLive?.close();
    await closing?.catch(() => {});
    await monitor.unsafe(
      "DROP TRIGGER IF EXISTS owned_expiry_block ON agent_interaction_requests",
    );
    await monitor.unsafe("DROP FUNCTION IF EXISTS owned_expiry_block_update()");
    await Promise.all([monitor.end(), blocker.end()]);
  }
}
