// Actual PostgreSQL locks and waiter observations for runtime fault scenarios.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { until } from "./tunnel-attachment-probe.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
export class RuntimeDatabase {
  constructor(fixture, proof) {
    this.sql = postgres(fixture.environment.DATABASE_URL, {
      max: 4,
      connect_timeout: 5,
      idle_timeout: 1,
    });
    this.proof = proof;
  }
  async lock(kind, id) {
    this.held = await this.sql.reserve();
    await this.held.unsafe("BEGIN");
    this.pid = (await this.held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
    if (kind === "authorization")
      await this.held.unsafe(
        "LOCK TABLE tunnel_attachments IN ACCESS EXCLUSIVE MODE",
      );
    else
      await this.held.unsafe("SELECT id FROM tunnels WHERE id=$1 FOR UPDATE", [
        id,
      ]);
  }
  async wait(name) {
    const rows = await until(async () => {
      const rows = await this.sql.unsafe(
        "SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
        [this.pid],
      );
      return rows.length ? rows : null;
    }, "actual runtime database waiter: " + name);
    assert.ok(rows.every((row) => row.wait_event_type === "Lock"));
    const locks = await this.sql.unsafe(
      "SELECT pid,locktype,mode,granted FROM pg_locks WHERE pid=ANY($1::int[]) AND NOT granted",
      [rows.map((row) => row.pid)],
    );
    assert.ok(locks.length);
    this.proof.push({ name, holder: this.pid, waiters: rows, locks });
    return rows;
  }
  async state(id) {
    const [row] = await this.sql.unsafe(
      "SELECT status,error_code,last_seen_at,secret_expires_at,secret_hash FROM tunnel_attachments WHERE id=$1",
      [id],
    );
    return {
      status: row.status,
      errorCode: row.error_code,
      lastSeen: row.last_seen_at !== null,
      secret: row.secret_expires_at !== null && row.secret_hash !== null,
    };
  }
  async release() {
    if (this.held) {
      const connection = this.held;
      this.held = undefined;
      try {
        await connection.unsafe("ROLLBACK");
      } finally {
        connection.release();
      }
    }
  }
  async close() {
    await this.release();
    await this.sql.end({ timeout: 5 });
  }
}
