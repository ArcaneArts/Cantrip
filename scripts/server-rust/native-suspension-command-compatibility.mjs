// Real Node and Rust repositories against separate migrated databases. Native
// frames here are worker evidence; native GUI/TUI execution is tested separately.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import {
  targetStateSql,
  localOwner as owner,
} from "./project-target-state.mjs";
import { nativeSuspensionRecordSchema } from "../../packages/protocol/dist/index.js";

const root = await mkdtemp(path.join(tmpdir(), "cantrip-suspension-command-"));
process.env.PGLITE_RUNTIME_DIR = path.join(root, "native-runtime");
const report = {
  suite: "native-suspension-command-transactions",
  root,
  runs: [],
  passed: false,
};
const workerGeneration = "f57d812b-37d4-4d1e-b87a-3503b0d89b23";
const envelope = command().protectedPayload;
const session = {
  ...command().session,
  threadId: "thread",
  runtimeGeneration: "runtime",
  connectionId: "view",
};
let fixture;
try {
  const executable = await buildRustExample("project-repository-fixture");
  for (const kind of ["node", "rust"]) {
    const run = { kind, steps: 0 };
    report.runs.push(run);
    fixture = await repositoryFixture({
      kind,
      executable,
      root,
      databaseMode: "pglite",
      requestTimeoutMs: 60_000,
    });
    const call = async (op, input, code) => {
      const result = await fixture.request({
        op: "native-command-" + op,
        owner,
        input,
      });
      run.steps++;
      assert.equal(result.rejected, Boolean(code), JSON.stringify(result));
      if (code) assert.equal(result.commandError, code, JSON.stringify(result));
      return result.value;
    };
    const query = async (sql) => {
      const result = await fixture.request({ op: "query-json", sql });
      assert.equal(result.rejected, false, JSON.stringify(result));
      return result.value;
    };
    const snapshot = async (phase, active, evidence) => {
      const raw = await query(
        "SELECT jsonb_build_object('state',native_suspension_state,'paused',automation_paused,'stopped',managed_autonomy_stopped) result FROM chats WHERE id='chat'",
      );
      const state = nativeSuspensionRecordSchema.parse(raw.state);
      assert.equal(state.phase, phase);
      assert.equal(raw.paused, phase !== "running" && phase !== "completed");
      assert.deepEqual(state.active, active);
      assert.deepEqual(state.checkpoint, evidence);
      assert.equal(state.target.workerId, "alpha");
      assert.equal(state.target.placementId, "github-alpha-main");
      assert.equal(state.actor.workerGeneration, workerGeneration);
      assert.equal(state.actor.runtimeGeneration, "runtime");
      return state;
    };
    for (const sql of targetStateSql()) await fixture.seed(sql);
    for (const sql of [
      "UPDATE chats SET status='idle',experience='agent',automation_paused=false",
      "UPDATE user_settings SET default_chat_permission_profile_id=':workspace'",
      "INSERT INTO managed_queue_states(chat_id) VALUES ('chat')",
      "UPDATE project_worktrees SET branch='main',detached=false,lifecycle_state='ready'",
    ])
      await fixture.seed(sql);
    await fixture.seed(
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('runtime-session','chat','alpha','github-alpha-main','thread')",
    );
    for (const ending of ["complete", "stop"]) {
      const rootId = "root-" + ending;
      const active = { threadId: "thread", turnId: "turn-" + ending };
      const start = command({
        operationId: rootId,
        origin: "terminal",
        session,
      });
      const admitted = await call("admit", start);
      assert.equal(
        admitted.receipt.status,
        "accepted",
        JSON.stringify(admitted),
      );
      const receipt = admitted.receipt;
      await call("dispatch", {
        workerId: "alpha",
        operationId: rootId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: start.payloadDigest,
        session,
        workerGeneration,
      });
      const rootAck = {
        workerId: "alpha",
        operationId: rootId,
        operationGeneration: receipt.operationGeneration,
        status: "applied",
        resultDigest: "b".repeat(64),
        protectedResult: envelope,
        rejectionCode: null,
        executionComplete: false,
        reconciliation: {
          nativeTurnId: active.turnId,
          runtimeGeneration: "runtime",
        },
      };
      await call("settle", rootAck);
      const control = async (name, method, paused = true) => {
        const input = command({
          operationId: ending + "-" + name,
          origin: "terminal",
          method,
          session,
          expectedActivationGeneration: receipt.activationGeneration,
          intent: {
            durableSuspension: true,
            workerGeneration,
            expectedTurnId: active.turnId,
            ...(method === "turn/pause"
              ? { paused, resumeAutonomy: !paused }
              : {}),
          },
        });
        const result = await call("admit", input);
        assert.equal(result.receipt.status, "accepted", JSON.stringify(result));
        await call("dispatch", {
          workerId: "alpha",
          operationId: input.operationId,
          operationGeneration: result.receipt.operationGeneration,
          payloadDigest: input.payloadDigest,
          session,
          workerGeneration,
        });
        return {
          workerId: "alpha",
          workerGeneration,
          operationId: input.operationId,
          operationGeneration: result.receipt.operationGeneration,
          status: "applied",
          resultDigest: "c".repeat(64),
          protectedResult: envelope,
          rejectionCode: null,
          executionComplete: false,
          durableSuspension: true,
        };
      };
      const evidence = {
        suspension: {
          ...active,
          checkpointId: "checkpoint-" + ending,
          revision: 1,
        },
        storageId: "00000000-0000-4000-8000-000000000001",
        runtimeVersion: "fixture",
        runtimeFingerprint: null,
      };
      const pause = await control("pause", "turn/pause");
      await snapshot("pausing", active, null);
      await call("settle", pause, "suspension-evidence-required");
      const pauseAck = { ...pause, suspensionEvidence: evidence };
      await call("settle", pauseAck);
      await call("settle", pauseAck);
      await snapshot("paused", active, evidence);
      const terminal = {
        ...rootAck,
        resultDigest: null,
        protectedResult: null,
        executionComplete: true,
        terminalResult: {
          resultDigest: "d".repeat(64),
          protectedResult: envelope,
        },
        executionStatus: "idle",
      };
      await call("settle", terminal, "suspended-execution-not-terminal");
      const resume = await control("resume", "turn/pause", false);
      await snapshot("resuming", active, evidence);
      await call("settle", pauseAck, "suspension-actor-stale");
      await call(
        "settle",
        { ...resume, workerGeneration: "00000000-0000-4000-8000-000000000002" },
        "suspension-actor-stale",
      );
      await fixture.seed(
        "CREATE FUNCTION fail_running() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.native_suspension_state->>'phase'='running' THEN RAISE EXCEPTION 'actual running write failure'; END IF; RETURN NEW; END $$",
      );
      await fixture.seed(
        "CREATE TRIGGER fail_running BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION fail_running()",
      );
      const failed = await fixture.request({
        op: "native-command-settle",
        owner,
        input: resume,
      });
      assert.equal(failed.rejected, true);
      await snapshot("resuming", active, evidence);
      assert.equal(
        (
          await query(
            `SELECT jsonb_build_object('status',status) result FROM native_commands WHERE operation_id='${resume.operationId}'`,
          )
        ).status,
        "dispatched",
      );
      await fixture.seed("DROP TRIGGER fail_running ON chats");
      await fixture.seed("DROP FUNCTION fail_running()");
      await call("settle", resume);
      await call("settle", resume);
      await snapshot("running", active, evidence);
      if (ending === "complete") {
        await call("settle", {
          ...terminal,
          reconciliation: {
            ...terminal.reconciliation,
            terminalStatus: "completed",
          },
        });
        await snapshot("completed", active, null);
      } else {
        const stop = await control("stop", "turn/interrupt");
        await snapshot("stopping", active, evidence);
        await call("settle", stop);
        await snapshot("stopped", active, null);
      }
    }
    await fixture.close();
    fixture = undefined;
  }
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await fixture?.close();
  const reportIndex = process.argv.indexOf("--report");
  if (reportIndex >= 0)
    await writeFile(
      process.argv[reportIndex + 1],
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report));
  if (report.passed) await rm(root, { recursive: true, force: true });
}
