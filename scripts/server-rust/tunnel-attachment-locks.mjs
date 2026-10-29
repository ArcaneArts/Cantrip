// Exercise the production runtime against genuinely blocked SQL operations.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { TunnelProbe, until } from "./tunnel-attachment-probe.mjs";
import { tunnelIds } from "./tunnel-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
export async function tunnelAttachmentLocks({ fixture, visit, result }) {
  const sql = postgres(fixture.environment.DATABASE_URL, {
    max: 4,
    connect_timeout: 5,
    idle_timeout: 1,
  });
  const probes = [];
  result.activationLocks = [];
  result.rawActivationLocks = [];
  let held;
  const create = () =>
    visit(
      "locked activation credentials",
      "POST",
      `/api/tunnels/${tunnelIds.main}/attachments`,
      { json: { clientId: "locked-runtime-client" }, status: 201 },
    );
  const connect = async (attachment) => {
    const probe = await new TunnelProbe(fixture, attachment.attachmentId, {
      secret: attachment.secret,
    }).open();
    probes.push(probe);
    probe.initialize("locked-runtime-client");
    return probe;
  };
  async function release() {
    if (held) {
      const connection = held;
      held = undefined;
      try {
        await connection.unsafe("ROLLBACK");
      } finally {
        connection.release();
      }
    }
  }
  async function lock(table, id) {
    held = await sql.reserve();
    await held.unsafe("BEGIN");
    const [{ pid }] = await held.unsafe("SELECT pg_backend_pid() pid");
    await held.unsafe(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    return pid;
  }
  async function wait(pid, name) {
    const rows = await until(async () => {
      const rows = await sql.unsafe(
        "SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
        [pid],
      );
      return rows.length ? rows : null;
    }, "actual blocked attachment SQL: " + name);
    assert.ok(rows.every((row) => row.wait_event_type === "Lock"));
    const locks = await sql.unsafe(
      "SELECT pid,locktype,mode,granted FROM pg_locks WHERE pid=ANY($1::int[]) AND NOT granted",
      [rows.map((row) => row.pid)],
    );
    assert.ok(locks.length);
    result.rawActivationLocks.push({ name, holder: pid, waiters: rows, locks });
    return rows;
  }
  async function state(id) {
    const [row] = await sql.unsafe(
      "SELECT status,error_code,last_seen_at,secret_expires_at,secret_hash FROM tunnel_attachments WHERE id=$1",
      [id],
    );
    return {
      status: row.status,
      errorCode: row.error_code,
      lastSeen: row.last_seen_at !== null,
      secret: row.secret_hash !== null && row.secret_expires_at !== null,
    };
  }
  try {
    await sql.unsafe(
      "CREATE TABLE runtime_activation_observations(id text,activated timestamptz)",
    );
    await sql.unsafe(
      "CREATE FUNCTION observe_runtime_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO runtime_activation_observations VALUES(NEW.id,NEW.last_seen_at); RETURN NEW; END $$",
    );
    await sql.unsafe(
      "CREATE TRIGGER runtime_activation_observed AFTER UPDATE ON tunnel_attachments FOR EACH ROW WHEN (NEW.last_seen_at IS NOT NULL AND NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at) EXECUTE FUNCTION observe_runtime_activation()",
    );
    const attachment = await create(),
      id = attachment.attachmentId;
    let holder = await lock("tunnels", tunnelIds.main);
    const first = await connect(attachment);
    await wait(holder, "first activation waits on parent");
    const replacement = await connect(attachment);
    await until(() => first.closed, "replacement closes blocked socket");
    assert.deepEqual(first.closed, {
      code: 1012,
      reason: "Attachment replaced",
    });
    const waiters = await wait(
      holder,
      "replacement is queued behind first activation",
    );
    assert.equal(
      waiters.length,
      1,
      "only the first activation reaches the locked database",
    );
    await release();
    await replacement.next((message) => message.value?.type === "ready");
    const generations = await sql.unsafe(
      "SELECT activated FROM runtime_activation_observations WHERE id=$1 ORDER BY activated",
      [id],
    );
    assert.equal(generations.length, 2);
    assert.ok(
      new Date(generations[1].activated).getTime() >
        new Date(generations[0].activated).getTime(),
    );
    let observed = await state(id);
    assert.deepEqual(observed, {
      status: "active",
      errorCode: null,
      lastSeen: true,
      secret: true,
    });
    result.activationLocks.push({
      name: "replacement while activation waits",
      waiters: waiters.length,
      strictlyIncreasingGenerations: true,
      state: observed,
      first: first.closed,
    });
    await replacement.close();
    await until(async () => {
      const value = await state(id);
      return value.status === "offline" ? value : null;
    }, "matching activation is marked offline");
    holder = await lock("tunnels", tunnelIds.main);
    const disconnected = await connect(attachment);
    await wait(holder, "activation waits before disconnect");
    await disconnected.close();
    await release();
    await until(async () => {
      const rows = await sql.unsafe(
        "SELECT count(*)::int count FROM runtime_activation_observations WHERE id=$1",
        [id],
      );
      const value = await state(id);
      return rows[0].count === 3 &&
        value.status === "offline" &&
        !value.lastSeen
        ? value
        : null;
    }, "late activation completes fenced offline cleanup");
    observed = await state(id);
    result.activationLocks.push({
      name: "disconnect during activation",
      state: observed,
      closed: disconnected.closed,
    });
    // Production expiry values come from JavaScript Date, hence millisecond
    // precision. SQL now() retains microseconds and would create a different
    // incarnation that the Source's exact Date fence intentionally cannot match.
    const [expiry] = await sql.unsafe(
      "UPDATE tunnel_attachments SET expires_at=date_trunc('milliseconds',clock_timestamp())+interval '2 seconds' WHERE id=$1 RETURNING expires_at::text expiry,mod(extract(microseconds FROM expires_at),1000)::text remainder",
      [id],
    );
    assert.equal(Number(expiry.remainder), 0);
    result.rawActivationLocks.push({
      name: "production millisecond expiry",
      ...expiry,
    });
    holder = await lock("tunnel_attachments", id);
    const expired = await connect(attachment);
    const expiryWaiters = await wait(
      holder,
      "activation UPDATE waits across attachment expiry",
    );
    assert.ok(
      expiryWaiters.some(
        (row) =>
          /^update/i.test(row.query.trim()) &&
          /tunnel_attachments/i.test(row.query),
      ),
      "actual activation write is blocked after capturing its timestamp",
    );
    await until(
      () => expired.closed,
      "expiry closes the pending activation",
      7000,
    );
    assert.deepEqual(expired.closed, {
      code: 1008,
      reason: "Attachment expired",
    });
    await release();
    observed = await until(async () => {
      const value = await state(id);
      result.expiryState = value;
      return value.status === "failed" &&
        value.errorCode === "attachment-expired" &&
        !value.secret
        ? value
        : null;
    }, "expiry waits for exact activation generation before stopping it");
    result.activationLocks.push({
      name: "expiry during activation write",
      state: observed,
      closed: expired.closed,
    });
  } finally {
    await release();
    for (const probe of probes) await probe.close();
    await sql.end({ timeout: 5 });
  }
}
