// Real PostgreSQL locks distinguish pre-lock snapshots from fresh fence reads.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  tunnelIds,
  attachmentIds,
  tunnelNow,
  secretExpiry,
  tunnelExpiry,
} from "./tunnel-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
};
export async function tunnelRepositoryLocks({ pair, urls, owner, report }) {
  report.lockRaces = [];
  for (const scenario of [
    "activation-secret-rotated",
    "stop-activation-replaced",
    "renew-retains-prelock-snapshot",
    "rotation-sees-locked-generation",
  ]) {
    const outcomes = [];
    report.lockRaces.push({ scenario, outcomes });
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 }),
        held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      try {
        await observer`DELETE FROM tunnel_attachment_direct_leases`;
        await observer`UPDATE tunnel_attachments SET client_id='client-main',status='offline',last_seen_at=NULL,secret_expires_at=${secretExpiry},expires_at=${tunnelExpiry},updated_at=${tunnelNow} WHERE id=${attachmentIds.main}`;
        await observer`UPDATE tunnels SET status='stopped',desired_state='stopped',updated_at=${tunnelNow} WHERE id=${tunnelIds.main}`;
        if (scenario === "renew-retains-prelock-snapshot")
          await observer`INSERT INTO tunnel_attachment_direct_leases(capability_id,attachment_id,lease_expires_at,status,created_at,updated_at) VALUES('lock-capability',${attachmentIds.main},'2027-01-01','active',${tunnelNow},${tunnelNow})`;
        transaction = locker.begin(async (sql) => {
          pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          await sql`SELECT id FROM tunnels WHERE id=${tunnelIds.main} FOR UPDATE`;
          held.resolve();
          await release.promise;
          if (scenario === "activation-secret-rotated")
            await sql`UPDATE tunnel_attachments SET secret_expires_at='2029-01-01T00:00:00.001Z' WHERE id=${attachmentIds.main}`;
          if (scenario === "stop-activation-replaced")
            await sql`UPDATE tunnel_attachments SET last_seen_at=${tunnelNow} WHERE id=${attachmentIds.main}`;
          if (scenario === "renew-retains-prelock-snapshot")
            await sql`UPDATE tunnel_attachments SET status='failed',expires_at='2026-12-01' WHERE id=${attachmentIds.main}`;
          if (scenario === "rotation-sees-locked-generation")
            await sql`UPDATE tunnel_attachments SET secret_expires_at='2029-01-01T00:00:00.500Z' WHERE id=${attachmentIds.main}`;
        });
        transaction.catch(held.reject);
        await held.promise;
        const request = {
          owner,
          attachment: attachmentIds.main,
          now: tunnelNow,
          ...{
            "activation-secret-rotated": {
              op: "tunnel-attachment-activate",
              client: "client-main",
              secret: secretExpiry,
            },
            "stop-activation-replaced": {
              op: "tunnel-attachment-stop",
              expected: {
                activatedAt: null,
                expiresAt: tunnelExpiry,
                secretExpiresAt: secretExpiry,
              },
            },
            "renew-retains-prelock-snapshot": {
              op: "tunnel-direct-renew",
              capability: "lock-capability",
              expires: "2028-01-01T00:00:00.000Z",
            },
            "rotation-sees-locked-generation": {
              op: "tunnel-attachment-create",
              tunnel: tunnelIds.main,
              input: {
                clientId: "client-main",
                expiresAt: tunnelExpiry,
                secretExpiresAt: secretExpiry,
                secretHash: "lock-rotation-hash",
              },
            },
          }[scenario],
        };
        pending = pair[i].request(request);
        let blocked;
        const end = Date.now() + 10000;
        do {
          blocked =
            await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
          if (blocked.length) break;
          assert.ok(
            Date.now() < end,
            "observe the actual tunnel writer blocked on the owning row",
          );
          await delay(10);
        } while (true);
        assert.equal(blocked.length, 1);
        assert.match(blocked[0].query, /for update/i);
        assert.match(blocked[0].query, /tunnels/);
        release.resolve();
        await transaction;
        const response = await pending;
        assert.equal(response.rejected, false);
        const stored = (
          await observer`SELECT jsonb_build_object('status',a.status,'seen',a.last_seen_at,'expires',a.expires_at,'secret',a.secret_expires_at,'leases',(SELECT jsonb_agg(jsonb_build_object('capability',l.capability_id,'status',l.status,'expires',l.lease_expires_at) ORDER BY l.capability_id) FROM tunnel_attachment_direct_leases l WHERE l.attachment_id=a.id)) state FROM tunnel_attachments a WHERE a.id=${attachmentIds.main}`
        )[0].state;
        if (
          scenario === "activation-secret-rotated" ||
          scenario === "stop-activation-replaced"
        )
          assert.equal(response.value, null);
        if (scenario === "activation-secret-rotated")
          assert.equal(stored.seen, null);
        if (scenario === "stop-activation-replaced")
          assert.equal(stored.status, "offline");
        if (scenario === "rotation-sees-locked-generation")
          assert.equal(
            response.value.secretExpiresAt,
            "2029-01-01T00:00:00.501Z",
          );
        if (scenario === "renew-retains-prelock-snapshot") {
          assert.ok(response.value);
          assert.equal(
            Date.parse(stored.leases[0].expires),
            Date.parse("2028-01-01"),
          );
          assert.equal(stored.status, "failed");
        }
        outcomes.push({ response, stored, blockedQuery: blocked[0].query });
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await observer.end();
        await locker.end();
      }
    }
    assert.deepEqual(
      { response: outcomes[1].response, stored: outcomes[1].stored },
      { response: outcomes[0].response, stored: outcomes[0].stored },
      scenario + " exact locked transaction outcome",
    );
  }
}
