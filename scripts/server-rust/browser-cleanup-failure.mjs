// Real SQL failure in one sibling must not cancel the other admitted revokes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
export async function browserCleanupFailure({
  fixture,
  databaseUrl,
  owner,
  result,
}) {
  const sql = postgres(databaseUrl, { max: 1 }),
    id = "bbbbbbbb-bbbb-4bbb-8bbb-000000000004",
    count = 1024,
    poison = "browser-cleanup-0000";
  try {
    await sql`INSERT INTO tunnels(id,owner_id,project_id,origin,management,protocol_hint,source_kind,destination_kind,destination_worker_id,protected_content,protected_operation_id,protected_revision,managed_by_kind,managed_by_id) VALUES(${id},${owner},'github','browser','managed-ephemeral','http-websocket','desktop-loopback','worker-tcp','alpha',${sql.json(tunnelRecord.protectedContent)},${id},1,'browser','browser')`;
    await sql`INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,secret_hash,status,error_code,secret_expires_at,expires_at,created_at) SELECT 'browser-cleanup-'||lpad(i::text,4,'0'),${id},'desktop-loopback','browser-cleanup-client-'||i,'fixture-secret-'||i,'offline','attachment-disconnected','2029-01-01','2030-01-01','2026-10-25'::timestamptz+i*interval '1 millisecond' FROM generate_series(0,${count - 1}) i`;
    await sql`CREATE TABLE browser_cleanup_witness(id text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1)`;
    await sql.unsafe(
      `CREATE FUNCTION browser_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${poison}' AND NEW.status='stopped' THEN RAISE EXCEPTION 'controlled browser sibling cleanup failure' USING ERRCODE='P0001'; END IF; IF NEW.tunnel_id='${id}' AND NEW.status='stopped' THEN INSERT INTO browser_cleanup_witness(id) VALUES(NEW.id) ON CONFLICT(id) DO UPDATE SET attempts=browser_cleanup_witness.attempts+1; END IF; RETURN NEW; END $$`,
    );
    await sql`CREATE TRIGGER browser_cleanup_failure BEFORE UPDATE ON tunnel_attachments FOR EACH ROW EXECUTE FUNCTION browser_cleanup_failure()`;
    const observation = await fixture.observe(
      "one attachment revoke fails",
      "POST",
      "/api/browsers/browser/tunnel",
      {
        csrf: !!fixture.client().csrf,
        status: 500,
        json: {
          tunnelId: id,
          workerId: "alpha",
          protocolHint: "http-websocket",
          resetAttachments: true,
          protectedRecord: {
            ...tunnelRecord,
            operationId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000005",
            revision: 2,
          },
        },
      },
    );
    result.cleanupFailure = {
      observation,
      expectedSiblings: count - 1,
      witnesses: [],
    };
    const end = Date.now() + 15000;
    for (;;) {
      const witness = (
        await sql`SELECT count(*)::integer completed,coalesce(sum(attempts),0)::integer attempts FROM browser_cleanup_witness`
      )[0];
      result.cleanupFailure.witnesses.push({ at: Date.now(), ...witness });
      if (witness.completed === count - 1) {
        assert.equal(witness.attempts, count - 1);
        break;
      }
      assert.ok(
        Date.now() < end,
        `all Source-style sibling revokes finish after the first real SQL failure: ${witness.completed}/${count - 1}`,
      );
      await delay(20);
    }
    const stored = (
      await sql`SELECT jsonb_build_object('stopped',(SELECT count(*) FROM tunnel_attachments WHERE tunnel_id=${id} AND status='stopped'),'poisonStatus',(SELECT status FROM tunnel_attachments WHERE id=${poison}),'revision',(SELECT protected_revision FROM tunnels WHERE id=${id})) result`
    )[0].result;
    assert.deepEqual(stored, {
      stopped: count - 1,
      poisonStatus: "offline",
      revision: 2,
    });
    result.cleanupFailure.stored = stored;
  } finally {
    await sql`DROP TRIGGER IF EXISTS browser_cleanup_failure ON tunnel_attachments`;
    await sql`DROP FUNCTION IF EXISTS browser_cleanup_failure()`;
    await sql`DELETE FROM tunnels WHERE id=${id}`;
    await sql`DROP TABLE IF EXISTS browser_cleanup_witness`;
    await sql.end();
  }
}
