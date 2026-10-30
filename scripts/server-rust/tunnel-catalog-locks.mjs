// Observe real blocked writes; retain the Source's pre-write snapshots and
// final management predicate rather than inventing stronger transaction fences.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { tunnelIds, tunnelRecord, tunnelNow } from "./tunnel-state.mjs";
import { stamp } from "./project-target-state.mjs";
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
export async function tunnelCatalogLocks({ pair, urls, owner, report }) {
  const id = "catalog-locked-tunnel";
  report.catalogLockRaces = [];
  for (const scenario of [
    "update-attachment-after-guard",
    "delete-attachment-after-guard",
    "update-revision-snapshot",
    "update-management-switch",
    "delete-management-switch",
  ]) {
    const outcomes = [];
    report.catalogLockRaces.push({ scenario, outcomes });
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      try {
        await observer.unsafe("DELETE FROM tunnels WHERE id=$1", [id]);
        await observer.unsafe(
          "INSERT INTO tunnels SELECT (jsonb_populate_record(NULL::tunnels,to_jsonb(t)||$1::text::jsonb)).* FROM tunnels t WHERE id=$2",
          [
            JSON.stringify({
              id,
              owner_id: owner,
              position: 200,
              protected_revision: 1,
              protected_operation_id: tunnelRecord.operationId,
              status: "stopped",
              desired_state: "stopped",
              error_code: null,
              active_connection_count: 0,
              bytes_from_source: 0,
              bytes_to_source: 0,
              created_at: stamp,
              updated_at: stamp,
            }),
            tunnelIds.main,
          ],
        );
        transaction = locker.begin(async (sql) => {
          pid = (await sql.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
          await sql.unsafe("SELECT id FROM tunnels WHERE id=$1 FOR UPDATE", [
            id,
          ]);
          held.resolve();
          await release.promise;
          if (scenario.includes("attachment-after-guard")) {
            await sql.unsafe(
              "INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,status,created_at,updated_at) VALUES('catalog-concurrent-attachment',$1,'desktop-loopback','concurrent-client','active',$2,$2)",
              [id, stamp],
            );
            await sql.unsafe(
              "INSERT INTO tunnel_attachment_direct_leases(capability_id,attachment_id,lease_expires_at,status,created_at,updated_at) VALUES('catalog-race-cap','catalog-concurrent-attachment','2030-01-01','active',$1,$1)",
              [stamp],
            );
          }
          if (scenario === "update-revision-snapshot")
            await sql.unsafe(
              "UPDATE tunnels SET protected_revision=2,protected_operation_id='competing-operation' WHERE id=$1",
              [id],
            );
          if (scenario.includes("management-switch"))
            await sql.unsafe(
              "UPDATE tunnels SET origin='browser',management='managed-durable',managed_by_kind='browser',managed_by_id=$2 WHERE id=$1",
              [id, id + "-owner"],
            );
        });
        transaction.catch(held.reject);
        await held.promise;
        const deleting = scenario.startsWith("delete");
        pending = pair[i].request({
          owner,
          now: tunnelNow,
          op: deleting ? "tunnel-delete" : "tunnel-update",
          tunnel: id,
          input: {
            protectedRecord: {
              ...tunnelRecord,
              revision: 2,
              operationId: "accepted-catalog-operation",
            },
          },
        });
        let blocked;
        const end = Date.now() + 10000;
        for (;;) {
          blocked = await observer.unsafe(
            "SELECT pid,query,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
            [pid],
          );
          if (blocked.length) break;
          assert.ok(
            Date.now() < end,
            "observe actual catalog write blocked on owning row",
          );
          await delay(10);
        }
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0].wait_event_type, "Lock");
        assert.match(
          blocked[0].query,
          deleting ? /delete from "?tunnels/i : /update "?tunnels/i,
        );
        release.resolve();
        await transaction;
        const response = await pending;
        assert.equal(response.rejected, false);
        const stored = (
          await observer.unsafe(
            "SELECT jsonb_build_object('tunnel',(SELECT to_jsonb(t) FROM tunnels t WHERE id=$1),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tunnel_attachments a WHERE tunnel_id=$1),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY capability_id) FROM tunnel_attachment_direct_leases l WHERE capability_id='catalog-race-cap')) state",
            [id],
          )
        )[0].state;
        if (scenario === "delete-attachment-after-guard") {
          assert.equal(response.value, true);
          assert.deepEqual(stored, {
            tunnel: null,
            attachments: null,
            leases: null,
          });
        } else if (scenario.includes("management-switch")) {
          assert.equal(response.value, deleting ? false : null);
          assert.equal(stored.tunnel.management, "managed-durable");
          assert.equal(stored.tunnel.protected_revision, 1);
        } else {
          assert.equal(stored.tunnel.protected_revision, 2);
          assert.equal(
            stored.tunnel.protected_operation_id,
            "accepted-catalog-operation",
          );
          if (scenario === "update-attachment-after-guard") {
            assert.equal(response.value.attachments[0].status, "active");
            assert.equal(response.value.capabilities.canEdit, false);
            assert.equal(stored.leases[0].status, "active");
          }
        }
        outcomes.push({ response, stored, blocked: blocked[0] });
        await observer.unsafe("DELETE FROM tunnels WHERE id=$1", [id]);
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await locker.end();
        await observer.end();
      }
    }
    assert.deepEqual(
      { response: outcomes[1].response, stored: outcomes[1].stored },
      { response: outcomes[0].response, stored: outcomes[0].stored },
      scenario + " exact response and persisted state",
    );
  }
}
