import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";

const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");
const classKey = 6128;
const objectKey = 140;

async function readClaim(sql, chatId, promptId) {
  const claims = await sql`
    SELECT q.id, q.status, q.request_operation_id AS "requestOperationId",
           q.operation_id AS "operationId",
           q.operation_generation AS "operationGeneration",
           q.native_turn_id AS "turnId", n.status AS "receiptStatus",
           n.rejection_code AS "rejectionCode",
           n.terminal_evidence->>'kind' AS "terminalEvidence", p.state AS "promptState"
    FROM managed_queue_claims q
    LEFT JOIN native_commands n ON n.chat_id=q.chat_id
      AND n.operation_id=q.operation_id
      AND n.operation_generation=q.operation_generation
    LEFT JOIN queued_prompts p ON p.chat_id=q.chat_id AND p.id=q.prompt_id
    WHERE q.chat_id=${chatId} AND q.prompt_id=${promptId}
    ORDER BY q.created_at, q.id
  `;
  return [...claims];
}

async function holdClaimAdmission(sql, promptId) {
  // The trigger holds the next admission in the test database. The original
  // claim transaction and its receipt travel through the normal queue APIs.
  await sql.unsafe(`
    CREATE FUNCTION cantrip_qa_hold_queue_admission() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${classKey}, ${objectKey});
      RETURN NEW;
    END $$;
    CREATE TRIGGER cantrip_qa_hold_queue_admission
      BEFORE UPDATE ON managed_queue_claims FOR EACH ROW
      WHEN (OLD.prompt_id=${literal(promptId)}
            AND OLD.status='claimed' AND NEW.status='accepted')
      EXECUTE FUNCTION cantrip_qa_hold_queue_admission();
  `);
  const blocker = await sql.reserve();
  await blocker`SELECT pg_advisory_lock(${classKey}, ${objectKey})`;
  return async () => {
    try {
      const [row] = await blocker`
        SELECT pg_advisory_unlock(${classKey}, ${objectKey}) AS released
      `;
      assert.equal(row.released, true);
    } finally {
      await blocker.release();
      await sql.unsafe(`
        DROP TRIGGER cantrip_qa_hold_queue_admission ON managed_queue_claims;
        DROP FUNCTION cantrip_qa_hold_queue_admission();
      `);
    }
  };
}

export async function interruptSharedQueue({
  fixture,
  chatId,
  promptId,
  firstReply,
  modelPosts,
  resume,
  replaceWorkerOwner,
  fault,
}) {
  const sql = postgres(fixture.environment.DATABASE_URL, { max: 3 });
  const snapshot = () => readClaim(sql, chatId, promptId);
  try {
    if (fault.phase === "claim") {
      let release = await holdClaimAdmission(sql, promptId);
      const resuming = resume();
      void resuming.catch(() => {});
      try {
        const before = await eventually(
          async () => {
            const [lock] = await sql`
              SELECT EXISTS(
                SELECT 1 FROM pg_locks WHERE locktype='advisory'
                  AND classid=${classKey} AND objid=${objectKey} AND NOT granted
              ) AS blocked
            `;
            return { rows: await snapshot(), blocked: lock.blocked };
          },
          ({ rows, blocked }) => {
            assert.equal(rows.length, 1);
            assert.equal(rows[0].status, "claimed");
            assert.equal(rows[0].operationId, null);
            assert.equal(rows[0].promptState, "claimed");
            assert.equal(blocked, true, "native admission must be waiting");
          },
        );
        fault.before = before.rows[0];
        fault.nativeAdmissionWaiting = before.blocked;
        assert.equal(modelPosts(), 0);
        await replaceWorkerOwner(async () => {
          fault.after = await snapshot();
          assert.deepEqual(fault.after, before.rows);
          assert.equal(modelPosts(), 0);
          // The database must be able to run the replacement peer's startup
          // operations once the death of the original process is confirmed.
          const unblock = release;
          release = null;
          await unblock();
        });
      } finally {
        await release?.();
      }
      fault.resume = await resuming;
      assert.equal(fault.resume.status, 409, JSON.stringify(fault.resume));
      assert.match(fault.resume.error, /remains paused/i);
      const [chat] = await sql`
        SELECT automation_paused AS paused FROM chats WHERE id=${chatId}
      `;
      assert.equal(chat.paused, true);
      fault.retainedBeforeRetry = await snapshot();
      assert.equal(fault.retainedBeforeRetry.length, 1);
      const [retained] = fault.retainedBeforeRetry;
      assert.equal(retained.id, fault.before.id);
      if (retained.status === "claimed") {
        assert.deepEqual(retained, fault.before);
      } else {
        assert.equal(retained.status, "rejected");
        assert.equal(retained.promptState, "pending");
        assert.equal(
          retained.turnId,
          null,
          "a lost admission must not start a turn",
        );
        assert.equal(retained.receiptStatus, "rejected");
        assert.equal(retained.rejectionCode, "not-dispatched");
        assert.equal(retained.terminalEvidence, "transport-ended");
      }
      assert.equal(modelPosts(), 0);
      fault.retry = await resume();
      assert.equal(fault.retry.paused, false, JSON.stringify(fault.retry));
    } else {
      const resuming = resume();
      void resuming.catch(() => {});
      try {
        const started = await eventually(
          () => firstReply.request,
          (request) =>
            assert.ok(request, "claimed prompt never reached the model"),
        );
        const [before] = await eventually(snapshot, (rows) => {
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, "consumed");
          assert.equal(rows[0].receiptStatus, "applied");
          assert.ok(rows[0].operationGeneration);
          assert.ok(rows[0].turnId);
        });
        fault.before = before;
        fault.resume = await resuming;
        assert.equal(fault.resume.paused, false, JSON.stringify(fault.resume));
        fault.modelStreamOpen = !started.completed && !started.closed;
        assert.ok(fault.modelStreamOpen);
        assert.equal(modelPosts(), 1);
        await replaceWorkerOwner();
        fault.after = await snapshot();
        assert.deepEqual(fault.after, [before]);
        assert.equal(firstReply.request, started);
        assert.equal(started.completed, false);
        assert.equal(started.closed, false);
        assert.equal(modelPosts(), 1);
      } finally {
        firstReply.release();
      }
    }
  } finally {
    await sql.end({ timeout: 3 });
  }
}

export async function verifyRecoveredQueueClaim({
  fixture,
  chatId,
  promptId,
  turnId,
  fault,
}) {
  const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  try {
    const claims = await readClaim(sql, chatId, promptId);
    const retired = fault.retainedBeforeRetry?.[0].status === "rejected";
    assert.equal(claims.length, retired ? 2 : 1);
    const [claim] = claims.filter((entry) => entry.status === "consumed");
    assert.ok(claim, "the original head must be consumed exactly once");
    if (retired) {
      const original = claims.find((entry) => entry.id === fault.before.id);
      assert.deepEqual(original, {
        ...fault.retainedBeforeRetry[0],
        status: "deferred",
        promptState: "consumed",
      });
    } else {
      assert.equal(claim.id, fault.before.id);
    }
    assert.equal(claim.status, "consumed");
    assert.equal(claim.promptState, "consumed");
    assert.equal(claim.receiptStatus, "applied");
    assert.equal(claim.turnId, turnId);
    if (fault.phase === "stream") assert.deepEqual(claim, fault.before);
    fault.completed = claim;
  } finally {
    await sql.end({ timeout: 3 });
  }
}
