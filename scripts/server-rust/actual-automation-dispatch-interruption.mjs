import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";

const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");
const lockClass = 6128;
const lockKey = 141;

export function automationDispatchWorkerEnvironment(file) {
  return {
    CANTRIP_TEST_AUTOMATION_DISPATCH: file,
    CANTRIP_TEST_AUTOMATION_WORKER_ENTRY: path.resolve(
      process.env.CANTRIP_TEST_WORKER_PACKAGE ??
        path.join(repositoryRoot, "cantrip_worker"),
      "dist/index.js",
    ),
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      "--import=" +
        new URL(
          "./worker-automation-dispatch-interruption.mjs",
          import.meta.url,
        ).href,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function holdCompletion(sql, id) {
  await sql.unsafe(`
    CREATE FUNCTION cantrip_qa_hold_automation_completion() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${lockClass}, ${lockKey});
      RETURN NEW;
    END $$;
    CREATE TRIGGER cantrip_qa_hold_automation_completion
      BEFORE UPDATE ON project_automation_runs FOR EACH ROW
      WHEN (OLD.automation_id=${literal(id)} AND OLD.status='dispatching' AND NEW.status='started')
      EXECUTE FUNCTION cantrip_qa_hold_automation_completion();
  `);
  const blocker = await sql.reserve();
  await blocker`SELECT pg_advisory_lock(${lockClass}, ${lockKey})`;
  return async () => {
    try {
      const [row] =
        await blocker`SELECT pg_advisory_unlock(${lockClass}, ${lockKey}) AS released`;
      assert.ok(row.released);
    } finally {
      await blocker.release();
      await sql.unsafe(`
        DROP TRIGGER cantrip_qa_hold_automation_completion ON project_automation_runs;
        DROP FUNCTION cantrip_qa_hold_automation_completion();
      `);
    }
  };
}

async function readProbe(file, name) {
  try {
    return JSON.parse(await readFile(file + "." + name, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function interruptAutomationDispatch({
  fixture,
  worker,
  workerId,
  chatId,
  id,
  file,
  phase,
  enable,
  nativeReply,
  modelPosts,
  evidence,
}) {
  const sql = postgres(fixture.environment.DATABASE_URL, { max: 3 });
  const snapshot = async () => [
    ...(await sql`
    SELECT id, status, worker_id AS "workerId", dispatch_instance_id AS "instanceId",
           fencing_token AS fence, attempt_count AS attempts, scheduled_for AS "scheduledFor"
    FROM project_automation_runs WHERE automation_id=${id}
    ORDER BY scheduled_for
  `),
  ];
  let release;
  try {
    if (phase === "finish") release = await holdCompletion(sql, id);
    const browserPeer = fixture.server.child;
    const original = await fixture.assertRemoteWorker(workerId);
    await writeFile(
      file + ".armed",
      JSON.stringify({ id, phase, otherOrigin: fixture.server.origin }),
    );
    const enabled = await enable();
    evidence.first = (
      await eventually(snapshot, (rows) => {
        assert.equal(rows.length, 1);
        const [run] = rows;
        assert.equal(run.status, "dispatching");
        assert.equal(run.workerId, workerId);
        assert.equal(run.instanceId, original.instanceId);
        assert.equal(run.fence, 1);
        assert.equal(run.attempts, 1);
        assert.equal(
          run.scheduledFor.toISOString(),
          enabled.find((a) => a.id === id).nextRunAt,
        );
      })
    )[0];

    evidence.workerProtection = await eventually(
      () => readProbe(file, "protected"),
      (reply) => {
        assert.equal(reply?.allowed, true);
        assert.ok(reply.requestId);
      },
    );
    evidence.contender = await eventually(
      () => readProbe(file, "contender"),
      (reply) => {
        assert.deepEqual(reply, {
          httpStatus: 200,
          accepted: false,
          status: "skipped",
        });
      },
    );
    const key = `automation:${id}:${evidence.first.scheduledFor.toISOString()}`;
    const admission = async () => {
      const [row] = await sql`
        SELECT EXISTS (SELECT 1 FROM chat_messages WHERE chat_id=${chatId} AND idempotency_key=${key}) AS message,
               EXISTS (SELECT 1 FROM native_history_items WHERE chat_id=${chatId} AND idempotency_key=${key}) AS history,
               (SELECT state FROM queued_prompts WHERE chat_id=${chatId} AND idempotency_key=${key}) AS "queueState"
      `;
      return row;
    };
    let stream;
    if (phase === "finish") {
      stream = await eventually(
        () => nativeReply.request,
        (request) => assert.ok(request),
      );
      await eventually(
        async () => {
          const [row] = await sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype='advisory' AND
              classid=${lockClass} AND objid=${lockKey} AND NOT granted
          ) AS blocked
        `;
          return row.blocked;
        },
        (blocked) => assert.equal(blocked, true),
      );
      evidence.finishWaiting = true;
      assert.equal(stream.completed, false);
      assert.equal(stream.closed, false);
      assert.equal(modelPosts(), 1);
    } else {
      assert.equal(modelPosts(), 0);
    }
    const kind = fixture.workerFixture.kind;
    evidence.replacement = await fixture.replacePeer(1, kind, {
      crash: true,
      afterCrash: async () => {
        evidence.afterCrash = await snapshot();
        assert.deepEqual(evidence.afterCrash, [evidence.first]);
        evidence.admissionAfterCrash = await admission();
        if (release) {
          const unlock = release;
          release = undefined;
          await unlock();
        }
      },
    });
    await eventually(
      () => fixture.workerClaim(workerId),
      (claim) => {
        assert.equal(claim?.instanceId, evidence.replacement.after.instanceId);
        assert.notEqual(claim.connectionId, original.connectionId);
      },
    );
    assert.equal(fixture.server.child, browserPeer);
    assert.equal(worker.exitCode, null);
    assert.equal(worker.signalCode, null);
    evidence.workerPid = worker.pid;
    if (stream) {
      assert.equal(nativeReply.request, stream);
      assert.equal(stream.closed, false);
      assert.equal(modelPosts(), 1);
      evidence.originalStreamOpen = true;
      nativeReply.release();
    }
    evidence.recovered = (
      await eventually(
        snapshot,
        (rows) => {
          assert.equal(rows.length, 1);
          const [run] = rows;
          evidence.latest = run;
          assert.ok(["started", "failed"].includes(run.status));
          assert.equal(run.instanceId, evidence.replacement.after.instanceId);
          assert.equal(run.id, evidence.first.id);
          assert.equal(run.fence, 2);
          assert.equal(run.attempts, 2);
          assert.equal(
            run.scheduledFor.toISOString(),
            evidence.first.scheduledFor.toISOString(),
          );
        },
        65_000,
      )
    )[0];
    evidence.admissionAfterRecovery = await admission();
    assert.equal(evidence.recovered.status, "started");
    return enabled;
  } finally {
    nativeReply.release?.();
    try {
      await release?.();
    } finally {
      await sql.end({ timeout: 3 });
    }
  }
}
