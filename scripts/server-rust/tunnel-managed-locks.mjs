// Hold actual PostgreSQL writes after the source's registration snapshot.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { tunnelIds, tunnelRecord, tunnelNow } from "./tunnel-state.mjs";
import { stamp } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const deferred = () => Promise.withResolvers();
export async function tunnelManagedLocks({ pair, urls, owner, report }) {
  report.managedLockRaces = [];
  const id = "managed-locked-tunnel",
    competingId = "managed-competing-tunnel";
  const managedBy = { kind: "project-share", id: "managed-race-owner" };
  for (const scenario of [
    "revision-snapshot",
    "row-deleted-after-snapshot",
    "management-switched-after-snapshot",
    "delete-management-switch",
    "duplicate-create",
  ]) {
    const outcomes = [];
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      const override = (rowId) => ({
        id: rowId,
        owner_id: owner,
        origin: "project-share",
        management: "managed-durable",
        managed_by_kind: managedBy.kind,
        managed_by_id: managedBy.id,
        source_kind: "desktop-loopback",
        source_worker_id: null,
        source_adapter: null,
        destination_kind: "worker-tcp",
        destination_adapter: null,
        destination_resource_id: null,
        destination_worker_id: "alpha",
        protected_content: tunnelRecord.protectedContent,
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
      });
      const insert = (sql, rowId) =>
        sql.unsafe(
          "INSERT INTO tunnels SELECT (jsonb_populate_record(NULL::tunnels,to_jsonb(t)||$1::text::jsonb)).* FROM tunnels t WHERE id=$2",
          [JSON.stringify(override(rowId)), tunnelIds.main],
        );
      try {
        await observer.unsafe("DELETE FROM tunnels WHERE id=ANY($1::text[])", [
          [id, competingId],
        ]);
        if (scenario !== "duplicate-create") await insert(observer, id);
        transaction = locker.begin(async (sql) => {
          pid = (await sql.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
          if (scenario === "duplicate-create")
            await sql.unsafe("LOCK TABLE tunnels IN SHARE ROW EXCLUSIVE MODE");
          else
            await sql.unsafe("SELECT id FROM tunnels WHERE id=$1 FOR UPDATE", [
              id,
            ]);
          held.resolve();
          await release.promise;
          if (scenario === "revision-snapshot")
            await sql.unsafe(
              "UPDATE tunnels SET protected_revision=3,protected_operation_id='competing-managed-operation' WHERE id=$1",
              [id],
            );
          if (scenario === "row-deleted-after-snapshot")
            await sql.unsafe("DELETE FROM tunnels WHERE id=$1", [id]);
          if (
            [
              "management-switched-after-snapshot",
              "delete-management-switch",
            ].includes(scenario)
          )
            await sql.unsafe(
              "UPDATE tunnels SET management='user-managed',origin='user',managed_by_kind=NULL,managed_by_id=NULL WHERE id=$1",
              [id],
            );
          if (scenario === "duplicate-create") await insert(sql, competingId);
        });
        transaction.catch(held.reject);
        await held.promise;
        const deleting = scenario === "delete-management-switch";
        pending = pair[i].request({
          owner,
          now: tunnelNow,
          op: deleting ? "tunnel-managed-remove" : "tunnel-managed-register",
          managedBy,
          input: {
            projectId: "github",
            origin: "project-share",
            management: "managed-durable",
            protocolHint: "tcp",
            source: { kind: "desktop-loopback" },
            destination: { kind: "worker-tcp", workerId: "alpha" },
            managedBy,
            desiredState: "started",
            status: "active",
          },
          protected: {
            id,
            protectedRecord: {
              ...tunnelRecord,
              revision: scenario === "duplicate-create" ? 1 : 2,
              operationId: "accepted-managed-operation",
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
            "observe actual managed write held by the owning lock",
          );
          await delay(10);
        }
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0].wait_event_type, "Lock");
        assert.match(
          blocked[0].query,
          deleting
            ? /delete from "?tunnels/i
            : scenario === "duplicate-create"
              ? /insert into "?tunnels/i
              : /update "?tunnels/i,
        );
        release.resolve();
        await transaction;
        const response = await pending;
        const stored = (
          await observer.unsafe(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY id) state FROM tunnels t WHERE id=ANY($1::text[])",
            [[id, competingId]],
          )
        )[0].state;
        let comparable;
        if (scenario === "duplicate-create") {
          assert.equal(response.rejected, true);
          assert.equal(response.databaseCode, "23505");
          assert.equal(stored[0].id, competingId);
          comparable = { rejected: true, databaseCode: response.databaseCode };
        } else {
          assert.equal(response.rejected, false);
          comparable = response;
          if (scenario === "row-deleted-after-snapshot") {
            assert.equal(response.value, null);
            assert.equal(stored, null);
          } else if (deleting) {
            assert.equal(response.value, false);
            assert.equal(stored[0].management, "user-managed");
          } else {
            assert.equal(stored[0].protected_revision, 2);
            assert.equal(
              stored[0].protected_operation_id,
              "accepted-managed-operation",
            );
            assert.equal(stored[0].management, "managed-durable");
          }
        }
        outcomes.push({ response, comparable, stored, blocked: blocked[0] });
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await observer.unsafe("DELETE FROM tunnels WHERE id=ANY($1::text[])", [
          [id, competingId],
        ]);
        await locker.end();
        await observer.end();
      }
    }
    report.managedLockRaces.push({ scenario, outcomes });
    assert.deepEqual(
      { response: outcomes[1].comparable, stored: outcomes[1].stored },
      { response: outcomes[0].comparable, stored: outcomes[0].stored },
      scenario + " exact response and committed state",
    );
  }
}
