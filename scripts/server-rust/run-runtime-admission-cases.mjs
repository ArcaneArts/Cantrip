import assert from "node:assert/strict";

export async function runRuntimeAdmissionCases({
  pair,
  seed,
  report,
  owner,
  other,
  stamp,
}) {
  const runtime = "66666666-6666-4666-8666-666666666666",
    configuration = "77777777-7777-4777-8777-777777777777",
    initialOperation = "88888888-8888-4888-8888-888888888888",
    worktree = "github-alpha-main";
  await seed(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='${worktree}'`,
  );
  await seed(
    `INSERT INTO run_configuration_runtimes (id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,state,created_at,updated_at) VALUES ('${runtime}','${owner}','github','${configuration}','${worktree}','alpha','${"a".repeat(64)}','${initialOperation}','idle','${stamp}','${stamp}')`,
  );
  let sequence = 0;
  const clocks = pair.map(() => new Map());
  const input = (operation, overrides = {}) => ({
    projectId: "github",
    configurationId: configuration,
    worktreeId: worktree,
    workerId: "alpha",
    operation,
    operationId: `99999999-9999-4999-8999-${String(++sequence).padStart(12, "0")}`,
    definitionRevision: operation === "stop" ? null : "b".repeat(64),
    codexEnvironmentRevision: operation === "stop" ? null : "c".repeat(64),
    ...overrides,
  });
  async function run(
    label,
    requestInput,
    { error = null, requestOwner = owner, newRuntime = false } = {},
  ) {
    const request = {
      op: "run-runtime-request",
      owner: requestOwner,
      project: "github",
      input: requestInput,
    };
    const before = Date.now(),
      results = [];
    for (const repo of pair) results.push(await repo.request(request));
    const after = Date.now();
    report.cases.push({
      label,
      request,
      expected: results[0],
      actual: results[1],
      clockWindow: [before, after],
    });
    const normalized = results.map((result, index) => {
      assert.equal(result.rejected, error !== null, label);
      if (error) {
        assert.equal(result.diagnostic, error, label);
        return null;
      }
      const value = structuredClone(result.value),
        receipt = value.operation;
      if (!value.replayed) {
        assert.ok(
          Date.parse(receipt.createdAt) >= before &&
            Date.parse(receipt.createdAt) <= after,
          label + " receipt clock",
        );
        clocks[index].set(receipt.id, receipt.createdAt);
      } else
        assert.equal(
          receipt.createdAt,
          clocks[index].get(receipt.id),
          label + " replay receipt time",
        );
      receipt.createdAt = "verified-receipt-clock";
      if (value.runtime && receipt.outcome === "accepted") {
        if (!value.replayed) {
          assert.ok(
            Date.parse(value.runtime.updatedAt) >= before &&
              Date.parse(value.runtime.updatedAt) <= after,
            label + " runtime clock",
          );
          clocks[index].set(
            "runtime:" + value.runtime.id,
            value.runtime.updatedAt,
          );
        } else
          assert.equal(
            value.runtime.updatedAt,
            clocks[index].get("runtime:" + value.runtime.id),
          );
        value.runtime.updatedAt = "verified-runtime-clock";
      }
      if (newRuntime) {
        const id = value.runtime.id;
        assert.match(
          id,
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        );
        assert.equal(value.runtime.terminalId, id);
        assert.equal(receipt.runtimeId, id);
        assert.ok(
          Date.parse(value.runtime.createdAt) >= before &&
            Date.parse(value.runtime.createdAt) <= after,
        );
        value.runtime.createdAt = "verified-created-clock";
        value.runtime.id =
          value.runtime.terminalId =
          receipt.runtimeId =
            "generated-runtime";
      }
      return value;
    });
    assert.deepEqual(normalized[1], normalized[0], label);
    return normalized[0];
  }
  const active = ["starting", "running", "restarting", "stopping"];
  for (const state of ["idle", ...active, "exited", "failed", "lost"])
    for (const operation of ["start", "restart", "stop"]) {
      await seed(
        `UPDATE run_configuration_runtimes SET state='${state}',generation=3,definition_revision='${"a".repeat(64)}',codex_environment_revision=NULL,requested_operation_id='${initialOperation}',started_at='${stamp}',ended_at='${stamp}',exit_code=7,signal='OLD',failure='{"phase":"spawn","code":"OLD","message":"old","retryable":true}',updated_at='${stamp}' WHERE id='${runtime}'`,
      );
      const request = input(operation),
        value = await run(
          `runtime admission ${operation} from ${state}`,
          request,
        );
      const outcome =
        operation === "start"
          ? active.includes(state)
            ? "already-active"
            : "accepted"
          : operation === "restart"
            ? active.includes(state)
              ? "accepted"
              : "not-active"
            : state === "stopping"
              ? "already-stopping"
              : active.includes(state)
                ? "accepted"
                : "not-active";
      assert.equal(value.operation.outcome, outcome);
      assert.equal(
        value.runtime.state,
        outcome === "accepted"
          ? { start: "starting", restart: "restarting", stop: "stopping" }[
              operation
            ]
          : state,
      );
      assert.equal(
        value.runtime.generation,
        3 + (outcome === "accepted" && operation !== "stop" ? 1 : 0),
      );
      assert.equal(value.operation.generation, value.runtime.generation);
      if (outcome === "accepted") {
        assert.equal(value.runtime.terminalId, runtime);
        assert.equal(value.runtime.requestedOperationId, request.operationId);
        assert.equal(value.runtime.endedAt, null);
        assert.equal(
          value.runtime.definitionRevision,
          operation === "stop" ? "a".repeat(64) : "b".repeat(64),
        );
        assert.equal(
          value.runtime.codexEnvironmentRevision,
          operation === "stop" ? null : "c".repeat(64),
        );
        assert.equal(
          value.runtime.startedAt,
          operation === "stop" ? stamp : null,
        );
        assert.equal(value.runtime.exitCode, operation === "stop" ? 7 : null);
        assert.equal(value.runtime.signal, operation === "stop" ? "OLD" : null);
        assert.equal(
          value.runtime.failure?.code ?? null,
          operation === "stop" ? "OLD" : null,
        );
      } else assert.equal(value.runtime.updatedAt, stamp);
      assert.deepEqual(
        {
          ...(await run(`runtime replays ${operation} from ${state}`, request)),
          replayed: false,
        },
        value,
      );
      if (state === "idle" && operation === "start") {
        for (const [field, replacement] of Object.entries({
          projectId: "folder",
          configurationId: initialOperation,
          worktreeId: "missing",
          workerId: "beta",
          operation: "stop",
          definitionRevision: "d".repeat(64),
          codexEnvironmentRevision: "e".repeat(64),
        }))
          await run(
            `runtime replay rejects changed ${field}`,
            { ...request, [field]: replacement },
            {
              error:
                "The Run configuration operation identity is already in use.",
            },
          );
        await run("runtime replay rejects foreign owner", request, {
          requestOwner: other,
          error: "The Run configuration operation identity is already in use.",
        });
      }
    }
  for (const [name, overrides, requestOwner] of [
    ["missing worktree", { worktreeId: "missing" }, owner],
    ["wrong worker", { workerId: "beta" }, owner],
    ["foreign owner", {}, other],
  ])
    await run(`runtime admission ${name}`, input("start", overrides), {
      requestOwner,
      error:
        "The Run configuration target worktree is not available on that worker.",
    });
  await seed(
    `UPDATE run_configuration_runtimes SET state='running' WHERE id='${runtime}'`,
  );
  await seed(
    `UPDATE project_worktrees SET worker_id='beta' WHERE id='${worktree}'`,
  );
  await run(
    "runtime active worker binding survives placement change",
    input("stop", { workerId: "beta" }),
    {
      error: "The active Run configuration runtime belongs to another worker.",
    },
  );
  await seed(
    `UPDATE project_worktrees SET worker_id='alpha',lifecycle_state='missing' WHERE id='${worktree}'`,
  );
  await run("runtime rejects nonready placement", input("start"), {
    error:
      "The Run configuration target worktree is not available on that worker.",
  });
  await seed(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='${worktree}'`,
  );
  await seed(
    `UPDATE run_configuration_runtimes SET terminal_id=NULL,state='idle',updated_at='${stamp}' WHERE id='${runtime}'`,
  );
  await seed(
    `UPDATE terminals SET active_worker_id='beta' WHERE id='${runtime}'`,
  );
  const rejected = input("start");
  await run("runtime rejects conflicting terminal binding", rejected, {
    error:
      "The Run configuration terminal identity belongs to another surface.",
  });
  const rollbackQuery = {
    op: "query-json",
    sql: `SELECT jsonb_build_object('terminal',r.terminal_id,'state',r.state,'updatedAt',to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'receipts',(SELECT count(*) FROM run_configuration_runtime_operations WHERE id='${rejected.operationId}')) result FROM run_configuration_runtimes r WHERE id='${runtime}'`,
  };
  const rollback = await Promise.all(
    pair.map((repo) => repo.request(rollbackQuery)),
  );
  for (const result of rollback) {
    assert.equal(result.rejected, false);
    assert.deepEqual(result.value, {
      terminal: null,
      state: "idle",
      updatedAt: stamp,
      receipts: 0,
    });
  }
  report.cases.push({
    label: "terminal conflict rolls back admission and receipt",
    request: rollbackQuery,
    expected: rollback[0],
    actual: rollback[1],
  });
  await seed(
    `UPDATE terminals SET active_worker_id='alpha' WHERE id='${runtime}'`,
  );
  const rebound = await run(
    "runtime reuses matching terminal without attaching twice",
    rejected,
  );
  assert.equal(rebound.runtime.terminalId, runtime);
  const terminalQuery = {
    op: "query-json",
    sql: `SELECT jsonb_build_object('kind',t.kind,'worker',t.active_worker_id,'worktree',t.worktree_id,'configuration',t.run_configuration_id,'runtime',t.run_configuration_runtime_id,'region',g.region,'members',(SELECT count(*) FROM tab_group_members WHERE tab_id=t.id)) result FROM terminals t JOIN tab_group_members m ON m.tab_id=t.id JOIN tab_groups g ON g.id=m.group_id WHERE t.id='${runtime}'`,
  };
  const terminals = await Promise.all(
    pair.map((repo) => repo.request(terminalQuery)),
  );
  for (const result of terminals) {
    assert.equal(result.rejected, false);
    assert.deepEqual(result.value, {
      kind: "run-configuration",
      worker: "alpha",
      worktree,
      configuration,
      runtime,
      region: "bottom",
      members: 1,
    });
  }
  report.cases.push({
    label: "runtime admission attaches terminal exactly once",
    request: terminalQuery,
    expected: terminals[0],
    actual: terminals[1],
  });
  await seed(`DELETE FROM run_configuration_runtimes WHERE id='${runtime}'`);
  for (const operation of ["stop", "restart"]) {
    const request = input(operation),
      value = await run(`absent runtime ${operation}`, request);
    assert.equal(value.runtime, null);
    assert.equal(value.operation.outcome, "not-active");
    assert.equal(value.operation.generation, 0);
    await run(`absent runtime ${operation} replay`, request);
  }
  const created = await run(
    "start creates absent runtime and terminal",
    input("start"),
    { newRuntime: true },
  );
  assert.equal(created.runtime.generation, 1);
  assert.equal(created.runtime.state, "starting");
  const lateRequest = input("start", { configurationId: initialOperation });
  const snapshotRequest = {
    op: "query-json",
    sql: `SELECT jsonb_build_object('runtimes',(SELECT count(*) FROM run_configuration_runtimes WHERE configuration_id='${initialOperation}'),'terminals',(SELECT count(*) FROM terminals WHERE run_configuration_id='${initialOperation}'),'receipts',(SELECT count(*) FROM run_configuration_runtime_operations WHERE id='${lateRequest.operationId}'),'members',(SELECT count(*) FROM tab_group_members WHERE project_id='github'),'layoutRevision',p.tab_layout_revision) result FROM projects p WHERE p.id='github'`,
  };
  const beforeRollback = await Promise.all(
    pair.map((repo) => repo.request(snapshotRequest)),
  );
  await seed(
    "CREATE FUNCTION run_admission_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejects receipt'; END $$",
  );
  await seed(
    "CREATE TRIGGER run_admission_reject_receipt BEFORE INSERT ON run_configuration_runtime_operations FOR EACH ROW EXECUTE FUNCTION run_admission_reject_receipt()",
  );
  const lateFailureRequest = {
    op: "run-runtime-request",
    owner,
    project: "github",
    input: lateRequest,
  };
  const failed = await Promise.all(
    pair.map((repo) => repo.request(lateFailureRequest)),
  );
  for (const result of failed) assert.equal(result.rejected, true);
  report.cases.push({
    label: "late receipt failure rejects admission",
    request: lateFailureRequest,
    expected: failed[0],
    actual: failed[1],
  });
  const afterRollback = await Promise.all(
    pair.map((repo) => repo.request(snapshotRequest)),
  );
  for (let i = 0; i < pair.length; i++) {
    assert.equal(beforeRollback[i].rejected, false);
    assert.equal(afterRollback[i].rejected, false);
    assert.deepEqual(
      afterRollback[i].value,
      beforeRollback[i].value,
      "receipt failure rolls back runtime, terminal, membership and layout revision",
    );
  }
  assert.deepEqual(afterRollback[1].value, afterRollback[0].value);
  report.cases.push({
    label: "late receipt failure rolls back all durable writes",
    request: snapshotRequest,
    expected: afterRollback[0],
    actual: afterRollback[1],
  });
  await seed(
    "DROP TRIGGER run_admission_reject_receipt ON run_configuration_runtime_operations",
  );
  await seed("DROP FUNCTION run_admission_reject_receipt()");
  const retried = await run(
    "failed receipt can retry same operation without orphan state",
    lateRequest,
    { newRuntime: true },
  );
  assert.equal(retried.operation.outcome, "accepted");
  assert.equal(retried.replayed, false);
}
