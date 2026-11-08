// Hold the actual credential UPDATE; a purge cannot precede committed storage.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eventually } from "./full-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { literal } from "./project-target-state.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function credentialReconnectShutdown({
  f,
  server,
  result,
  target,
  reconnect,
  restart,
}) {
  assert.ok(
    f.environment.DATABASE_URL,
    "Use only the isolated external PostgreSQL fixture",
  );
  const monitor = postgres(f.environment.DATABASE_URL, { max: 1 }),
    blocker = postgres(f.environment.DATABASE_URL, { max: 1 }),
    lockId = 19384767;
  let acquired, failed, release, held, closing, live;
  const ready = new Promise((yes, no) => {
      acquired = yes;
      failed = no;
    }),
    unlock = new Promise((yes) => {
      release = yes;
    });
  const blocked = async () =>
    Number(
      (
        await monitor.unsafe(
          `SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND objid=${lockId} AND classid=0 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
        )
      )[0].count,
    );
  const saved = async () => ({
    ...(
      await monitor.unsafe(
        `SELECT credential_state AS state,credential_revision AS revision,protected_credential AS credential,credential_subject_blind_index AS subject FROM model_provider_accounts WHERE id=${literal(target.id)}`,
      )
    )[0],
  });
  const purges = () =>
    result.commands.filter(
      (c) =>
        c.command.type === "provider.auth.legacy.purge" &&
        c.command.providerAccountId === target.id,
    );
  try {
    live = new LiveProbe(f);
    await live.open();
    await live.initialized();
    await live.subscribed("credential shutdown observer");
    await f.sql([
      `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,credential_state) VALUES(${literal(target.id)},${literal(target.provider)},${literal(JSON.stringify(policyEnvelope))},${literal(target.home)},100,'migration-needed')`,
      `CREATE FUNCTION owned_credential_block_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(target.id)} THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`,
      "CREATE TRIGGER owned_credential_block BEFORE UPDATE ON model_provider_accounts FOR EACH ROW EXECUTE FUNCTION owned_credential_block_update()",
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
      assert.ok(count >= 1, "Actual captured-credential UPDATE is blocked"),
    );
    assert.equal(
      purges().length,
      0,
      "No purge request before the credential commit",
    );
    assert.deepEqual(await saved(), {
      state: "migration-needed",
      revision: 0,
      credential: null,
      subject: null,
    });
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
    assert.equal(purges().length, 0);
    release();
    await held;
    await closing;
    const retained = await saved();
    result.shutdown = {
      actualBlockedCredentialUpdate: true,
      purgeBeforeCommit: false,
      saved: retained,
      purgeRequests: purges().length,
      exit: { code: server.child.exitCode, signal: server.child.signalCode },
    };
    assert.deepEqual(retained, {
      state: "signed-in",
      revision: 1,
      credential: target.captured.protectedCredential,
      subject: target.captured.subjectBlindIndex,
    });
    assert.equal(
      purges().length,
      0,
      "Closed worker channel retains its legacy copy for a later reconnect",
    );
    assert.equal(server.child.exitCode, 0);
    await restart();
    await eventually(purges, (records) => assert.equal(records.length, 1));
    assert.deepEqual(
      await saved(),
      retained,
      "Restart capture retains the committed envelope and revision",
    );
    result.restart = { saved: await saved(), purgeRequests: purges().length };
  } finally {
    release();
    await held?.catch(() => {});
    await live?.close();
    await closing?.catch(() => {});
    try {
      await monitor.unsafe(
        "DROP TRIGGER IF EXISTS owned_credential_block ON model_provider_accounts",
      );
      await monitor.unsafe(
        "DROP FUNCTION IF EXISTS owned_credential_block_update()",
      );
    } finally {
      await Promise.all([
        monitor.end({ timeout: 5 }),
        blocker.end({ timeout: 5 }),
      ]);
    }
  }
}
