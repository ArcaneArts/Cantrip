import assert from "node:assert/strict";

export async function runRuntimeContentionCases({ pair, seed, report, owner }) {
  const configuration = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const worktree = "github-alpha-main";
  const input = {
    projectId: "github",
    configurationId: configuration,
    worktreeId: worktree,
    workerId: "alpha",
    operation: "start",
    operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    definitionRevision: "a".repeat(64),
    codexEnvironmentRevision: null,
  };
  await seed(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='${worktree}'`,
  );
  const runtimes = [];
  for (const [index, repo] of pair.entries()) {
    const before = Date.now();
    const result = await repo.request({
      op: "run-runtime-race",
      owner,
      project: "github",
      inputs: Array.from({ length: 12 }, () => input),
    });
    report.cases.push({ label: `concurrent duplicate start ${index}`, result });
    assert.equal(result.rejected, false, result.diagnostic);
    assert.equal(result.value.length, 12);
    assert.equal(result.value.filter((v) => !v.replayed).length, 1);
    const first = result.value.find((v) => !v.replayed);
    assert.equal(first.operation.outcome, "accepted");
    assert.equal(first.runtime.state, "starting");
    assert.equal(first.runtime.generation, 1);
    assert.equal(first.operation.runtimeId, first.runtime.id);
    assert.equal(first.runtime.terminalId, first.runtime.id);
    assert.ok(
      Date.parse(first.operation.createdAt) >= before &&
        Date.parse(first.operation.createdAt) <= Date.now(),
    );
    for (const value of result.value) {
      assert.deepEqual(value.operation, first.operation);
      assert.deepEqual(value.runtime, first.runtime);
    }
    runtimes.push(first.runtime);
    const snapshot = await repo.request({
      op: "query-json",
      sql: `SELECT json_build_object('runtimes',(SELECT count(*) FROM run_configuration_runtimes WHERE configuration_id='${configuration}'),'receipts',(SELECT count(*) FROM run_configuration_runtime_operations WHERE configuration_id='${configuration}'),'terminals',(SELECT count(*) FROM terminals WHERE id='${first.runtime.id}'),'members',(SELECT count(*) FROM tab_group_members WHERE tab_id='${first.runtime.id}')) AS result`,
    });
    report.cases.push({
      label: `concurrent start durable uniqueness ${index}`,
      result: snapshot,
    });
    assert.equal(snapshot.rejected, false, snapshot.diagnostic);
    assert.deepEqual(snapshot.value, {
      runtimes: 1,
      receipts: 1,
      terminals: 1,
      members: 1,
    });
  }
  const inputs = Array.from({ length: 12 }, (_, i) => ({
    ...input,
    operation: "stop",
    operationId: `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, "0")}`,
    definitionRevision: null,
  }));
  for (const [index, repo] of pair.entries()) {
    const result = await repo.request({
      op: "run-runtime-race",
      owner,
      project: "github",
      inputs,
    });
    report.cases.push({ label: `concurrent distinct stops ${index}`, result });
    assert.equal(result.rejected, false, result.diagnostic);
    assert.equal(
      result.value.filter((v) => v.operation.outcome === "accepted").length,
      1,
    );
    assert.equal(
      result.value.filter((v) => v.operation.outcome === "already-stopping")
        .length,
      11,
    );
    for (const value of result.value) {
      assert.equal(value.replayed, false);
      assert.equal(value.runtime.id, runtimes[index].id);
      assert.equal(value.runtime.state, "stopping");
      assert.equal(value.runtime.generation, 1);
    }
    const stopped = result.value.find(
      (v) => v.operation.outcome === "accepted",
    ).runtime;
    const observation = {
      runtimeId: stopped.id,
      projectId: stopped.projectId,
      configurationId: stopped.configurationId,
      worktreeId: stopped.worktreeId,
      workerId: stopped.workerId,
      terminalId: stopped.terminalId,
      definitionRevision: stopped.definitionRevision,
      codexEnvironmentRevision: stopped.codexEnvironmentRevision,
      generation: stopped.generation,
      operationId: stopped.requestedOperationId,
      state: "exited",
      startedAt: null,
      endedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      failure: null,
    };
    const observed = await repo.request({
      op: "run-runtime-observation-race",
      owner,
      worker: "alpha",
      project: "github",
      inputs: Array.from({ length: 12 }, () => observation),
    });
    report.cases.push({
      label: `concurrent identical exit observations ${index}`,
      result: observed,
    });
    assert.equal(observed.rejected, false, observed.diagnostic);
    assert.equal(observed.value.filter((v) => v.applied).length, 1);
    assert.equal(
      observed.value.filter((v) => v.reason === "unchanged").length,
      11,
    );
    for (const value of observed.value) {
      assert.equal(value.runtime.state, "exited");
      assert.equal(value.runtime.generation, stopped.generation);
      assert.equal(
        value.runtime.requestedOperationId,
        stopped.requestedOperationId,
      );
      assert.deepEqual(value.runtime, observed.value[0].runtime);
    }
  }
}
