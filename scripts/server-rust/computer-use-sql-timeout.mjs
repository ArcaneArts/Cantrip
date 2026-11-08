// An actual blocked INSERT outlives its worker command's 30-second deadline.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { gate } from "./worker-log-stream-probe.mjs";
import { eventually } from "./full-worker.mjs";
import { id, input } from "./computer-use-http-fixtures.mjs";
import { activityEvent } from "./computer-use-http-additional.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function computerUseSqlTimeout({
  f,
  state,
  worker,
  result,
  visit,
}) {
  assert.ok(
    f.environment.DATABASE_URL,
    "SQL-timeout qualification requires the fixture-owned external PostgreSQL URL",
  );
  const monitor = postgres(f.environment.DATABASE_URL, { max: 1 }),
    blocker = postgres(f.environment.DATABASE_URL, { max: 1 });
  try {
    for (const approval of [false, true]) {
      const key = id(approval ? 243 : 241),
        operation = id(approval ? 242 : 240),
        lockId = approval ? 19384757 : 19384756;
      const acquired = gate(),
        unlock = gate(),
        finishWorker = gate();
      const table = approval ? "agent_interaction_requests" : "chat_messages";
      const column = approval ? "request_key" : "id";
      await f.sql([
        `CREATE FUNCTION owned_cua_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${column}=${literal(key)} THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`,
        `CREATE TRIGGER owned_cua_block BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION owned_cua_block_insert()`,
      ]);
      const held = blocker.begin(async (transaction) => {
        await transaction.unsafe(`SELECT pg_advisory_xact_lock(${lockId})`);
        acquired.resolve();
        await unlock.promise;
      });
      await acquired.promise;
      state.events = (command) =>
        approval
          ? [
              {
                type: "computer-use.approval.request",
                operationId: command.request.operationId,
                request: protectedInteraction(key, {
                  projectId: "github",
                  provenance: {
                    owner: "computer-use",
                    chatId: "chat",
                    workerId: "alpha",
                    executionLaneId: null,
                    threadId: null,
                    turnId: null,
                    itemId: null,
                  },
                  classification: { kind: "permissions" },
                }),
              },
            ]
          : [activityEvent(command.request.operationId, key)];
      state.hold = finishWorker.promise;
      let request;
      const blocked = async () =>
        Number(
          (
            await monitor.unsafe(
              `SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND objid=${lockId} AND classid=0 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
            )
          )[0].count,
        );
      try {
        const started = performance.now();
        request = visit(
          "actual SQL insert outlives command deadline " + approval,
          "POST",
          "/api/chats/chat/computer-use/operation",
          {
            status: 502,
            json: input(approval ? 242 : 240, "input.click"),
            timeoutMs: 60000,
          },
        );
        await eventually(blocked, (count) => assert.equal(count, 1), 15000);
        if (approval)
          worker.notify({
            type: "computer-use.approval.terminal",
            chatId: "chat",
            requestKey: key,
            status: "interrupted",
          });
        await request;
        const elapsedMs = performance.now() - started;
        assert.ok(elapsedMs >= 30000 && elapsedMs < 55000, `${elapsedMs}ms`);
        assert.equal(
          await blocked(),
          1,
          "actual INSERT is still blocked after HTTP timeout",
        );
        const before = await monitor.unsafe(
          `SELECT count(*) AS count FROM ${table} WHERE ${column}=${literal(key)}`,
        );
        assert.equal(Number(before[0].count), 0);
        unlock.resolve();
        await held;
        let saved;
        await eventually(
          async () => {
            const query = approval
              ? `SELECT COALESCE((SELECT jsonb_build_object('key',request_key,'status',status,'owner',interaction_owner) FROM agent_interaction_requests WHERE request_key=${literal(key)}),'null'::jsonb)::text result`
              : `SELECT COALESCE((SELECT jsonb_build_object('id',id,'role',role,'opaque',protected_content) FROM chat_messages WHERE id=${literal(key)}),'null'::jsonb)::text result`;
            [saved] = await f.sql([], [query]);
            return saved;
          },
          (row) => {
            assert.ok(row);
            if (approval) assert.equal(row.status, "interrupted");
            else assert.equal(row.role, "assistant");
          },
        );
        (result.deadlines ??= []).push({
          name: "actual blocked SQL survives command timeout " + approval,
          elapsedMs,
          deadlineMs: 30000,
        });
        result.cases.push({
          name: approval
            ? "started approval INSERT and independent terminal finish after the actual command timeout"
            : "started opaque activity INSERT finishes after the actual command timeout",
          saved,
          blockedAfterTimeout: true,
        });
      } finally {
        unlock.resolve();
        finishWorker.resolve();
        delete state.events;
        delete state.hold;
        await held;
        if (request) await request.catch(() => {});
        await f.sql([
          `DROP TRIGGER owned_cua_block ON ${table}`,
          "DROP FUNCTION owned_cua_block_insert()",
        ]);
      }
    }
  } finally {
    await Promise.all([monitor.end(), blocker.end()]);
  }
}
