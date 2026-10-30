import assert from "node:assert/strict";

export async function runRuntimeCases({
  pair,
  seed,
  report,
  owner,
  other,
  stamp,
}) {
  const id = "11111111-1111-4111-8111-111111111111",
    configuration = "22222222-2222-4222-8222-222222222222",
    operation = "33333333-3333-4333-8333-333333333333",
    worktree = "github-alpha-main";
  await seed(
    `UPDATE run_configuration_runtimes SET terminal_id='terminal',state='starting',generation=3,created_at='${stamp}',updated_at='${stamp}' WHERE id='${id}'`,
  );
  const observation = {
    runtimeId: id,
    projectId: "github",
    configurationId: configuration,
    worktreeId: worktree,
    workerId: "alpha",
    definitionRevision: "a".repeat(64),
    codexEnvironmentRevision: null,
    generation: 3,
    operationId: operation,
    terminalId: "terminal",
    state: "running",
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    failure: null,
  };
  const verifiedClocks = pair.map(() => new Map());
  async function run(label, input, expectedError = null) {
    const request = { owner, project: "github", worker: "alpha", ...input };
    const start = Date.now(),
      results = [];
    for (const repo of pair) results.push(await repo.request(request));
    const end = Date.now();
    report.cases.push({
      label,
      request,
      expected: results[0],
      actual: results[1],
      clockWindow: [start, end],
    });
    const values = results.map((result, index) => {
      assert.equal(result.rejected, expectedError !== null, label);
      if (expectedError) {
        assert.equal(result.diagnostic, expectedError);
        return null;
      }
      const value = structuredClone(result.value);
      if (value?.applied === true) {
        assert.ok(
          Date.parse(value.runtime.updatedAt) >= start &&
            Date.parse(value.runtime.updatedAt) <= end,
          label + " transaction clock",
        );
        verifiedClocks[index].set(value.runtime.id, value.runtime.updatedAt);
      }
      const runtime = value?.runtime ?? value;
      if (
        runtime?.id &&
        verifiedClocks[index].get(runtime.id) === runtime.updatedAt
      )
        runtime.updatedAt = "verified-operation-clock";
      return value;
    });
    assert.deepEqual(values[1], values[0], label);
    return values[0];
  }
  const fetched = await run("run runtime owned get", {
    op: "run-runtime-get",
    configuration,
    worktree,
  });
  assert.equal(fetched.id, id);
  assert.equal(
    await run("run runtime foreign get", {
      op: "run-runtime-get",
      owner: other,
      configuration,
      worktree,
    }),
    null,
  );
  assert.equal(
    await run("run runtime wrong worktree", {
      op: "run-runtime-get",
      configuration,
      worktree: "missing",
    }),
    null,
  );
  for (const input of [
    {},
    { configuration },
    { worktree },
    { configuration: "" },
    { limit: 0 },
    { limit: 999 },
  ])
    assert.equal(
      (
        await run("run runtime list filters", {
          op: "run-runtime-list",
          ...input,
        })
      ).length,
      1,
    );
  assert.deepEqual(
    await run("run runtime foreign list", {
      op: "run-runtime-list",
      owner: other,
    }),
    [],
  );
  assert.deepEqual(
    await run("run runtime foreign worker identities", {
      op: "run-runtime-identities",
      worker: "beta",
    }),
    [],
  );
  assert.equal(
    (
      await run("run runtime active identity", { op: "run-runtime-identities" })
    )[0].runtimeId,
    id,
  );
  assert.equal(
    await run("run runtime foreign observation", {
      op: "run-runtime-observe",
      owner: other,
      observation,
    }),
    null,
  );
  assert.equal(
    await run("run runtime wrong worker observation", {
      op: "run-runtime-observe",
      worker: "beta",
      observation,
    }),
    null,
  );
  for (const field of [
    "projectId",
    "configurationId",
    "worktreeId",
    "definitionRevision",
    "codexEnvironmentRevision",
    "terminalId",
  ])
    await run(
      `runtime observation identity ${field}`,
      {
        op: "run-runtime-observe",
        observation: { ...observation, [field]: "different" },
      },
      "Worker Run configuration state does not match its durable identity.",
    );
  assert.equal(
    (
      await run("runtime stale generation", {
        op: "run-runtime-observe",
        observation: { ...observation, generation: 2 },
      })
    ).reason,
    "stale-generation",
  );
  await run(
    "runtime future generation",
    {
      op: "run-runtime-observe",
      observation: { ...observation, generation: 4 },
    },
    "Worker Run configuration generation is ahead of durable state.",
  );
  assert.equal(
    (
      await run("runtime stale operation", {
        op: "run-runtime-observe",
        observation: { ...observation, operationId: "different" },
      })
    ).reason,
    "stale-operation",
  );
  const allowed = {
    idle: [],
    starting: ["running", "stopping", "exited", "failed", "lost"],
    running: ["stopping", "exited", "failed", "lost"],
    restarting: ["starting", "running", "stopping", "exited", "failed", "lost"],
    stopping: ["idle", "exited", "failed", "lost"],
    exited: [],
    failed: [],
    lost: [],
  };
  for (const current of Object.keys(allowed))
    for (const state of Object.keys(allowed)) {
      await seed(
        `UPDATE run_configuration_runtimes SET state='${current}',started_at='${stamp}',ended_at='${stamp}',exit_code=7,signal='OLD',failure=NULL,updated_at='${stamp}' WHERE id='${id}'`,
      );
      const value = await run(`runtime transition ${current} to ${state}`, {
        op: "run-runtime-observe",
        observation: { ...observation, state },
      });
      const reason =
        current === state
          ? "unchanged"
          : allowed[current].includes(state)
            ? "applied"
            : "invalid-transition";
      assert.equal(value.reason, reason);
      assert.equal(value.applied, reason === "applied");
      assert.equal(
        value.runtime.startedAt,
        stamp,
        "null start preserves previous start",
      );
      if (value.applied) {
        assert.equal(value.runtime.endedAt, null);
        assert.equal(value.runtime.exitCode, null);
        assert.equal(value.runtime.signal, null);
      } else assert.equal(value.runtime.updatedAt, stamp);
    }
  await seed(
    `UPDATE run_configuration_runtimes SET state='running',updated_at='${stamp}' WHERE id='${id}'`,
  );
  const failedObservation = {
    ...observation,
    state: "failed",
    startedAt: "2026-01-02T03:04:05.123Z",
    endedAt: "2026-01-02T03:05:06.789Z",
    exitCode: 127,
    signal: "SIGTERM",
    failure: {
      phase: "spawn",
      code: "SPAWN_FAILED",
      message: "Cannot start café 🧪",
      retryable: true,
    },
  };
  const failed = await run("runtime persists complete failure observation", {
    op: "run-runtime-observe",
    observation: failedObservation,
  });
  for (const key of [
    "state",
    "startedAt",
    "endedAt",
    "exitCode",
    "signal",
    "failure",
  ])
    assert.deepEqual(failed.runtime[key], failedObservation[key]);
  const persisted = await run("runtime reads persisted failure", {
    op: "run-runtime-get",
    configuration,
    worktree,
  });
  assert.deepEqual(persisted.failure, failedObservation.failure);
  const replayed = await run(
    "runtime same-state observation preserves stored details",
    {
      op: "run-runtime-observe",
      observation: { ...observation, state: "failed" },
    },
  );
  assert.equal(replayed.reason, "unchanged");
  assert.deepEqual(replayed.runtime, persisted);
  await seed(
    `UPDATE run_configuration_runtimes SET state='running' WHERE id='${id}'`,
  );
  const beforeFailure = await run("runtime before rejected database write", {
    op: "run-runtime-get",
    configuration,
    worktree,
  });
  const rejectedWrite = {
    owner,
    project: "github",
    worker: "alpha",
    op: "run-runtime-observe",
    observation: { ...failedObservation, signal: "X".repeat(101) },
  };
  const rejectedResults = await Promise.all(
    pair.map((repo) => repo.request(rejectedWrite)),
  );
  for (const result of rejectedResults) assert.equal(result.rejected, true);
  report.cases.push({
    label: "runtime database constraint rejects entire observation",
    request: rejectedWrite,
    expected: rejectedResults[0],
    actual: rejectedResults[1],
  });
  assert.deepEqual(
    await run("runtime rejected write leaves durable state intact", {
      op: "run-runtime-get",
      configuration,
      worktree,
    }),
    beforeFailure,
  );
  await seed(
    `UPDATE run_configuration_runtimes SET state='running',updated_at='${stamp}' WHERE id='${id}'`,
  );
  assert.equal(
    await run("runtime deletion protects active state", {
      op: "run-runtime-delete",
      ids: [id],
    }),
    0,
  );
  assert.equal(
    await run("runtime deletion empty ids", {
      op: "run-runtime-delete",
      ids: [],
    }),
    0,
  );
  await seed(
    `UPDATE run_configuration_runtimes SET state='exited' WHERE id='${id}'`,
  );
  assert.deepEqual(
    await run("inactive runtime omitted from worker identities", {
      op: "run-runtime-identities",
    }),
    [],
  );
  assert.equal(
    await run("runtime deletion foreign owner", {
      op: "run-runtime-delete",
      owner: other,
      ids: [id],
    }),
    0,
  );
  assert.equal(
    await run("runtime deletion foreign project", {
      op: "run-runtime-delete",
      project: "folder",
      ids: [id],
    }),
    0,
  );
  assert.equal(
    await run("runtime deletion duplicate ids", {
      op: "run-runtime-delete",
      ids: [id, id],
    }),
    1,
  );
  assert.equal(
    await run("runtime deletion repeated", {
      op: "run-runtime-delete",
      ids: [id],
    }),
    0,
  );
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    configuration: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
    active: i % 2 === 0,
    updated: new Date(
      Date.parse(stamp) + Math.floor(i / 3) * 1000,
    ).toISOString(),
    created: new Date(Date.parse(stamp) + i * 1000).toISOString(),
  }));
  await seed(`INSERT INTO run_configuration_runtimes
    (id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,state,created_at,updated_at)
    VALUES ${rows.map((row) => `('${row.id}','${owner}','github','${row.configuration}','${worktree}','alpha','${"a".repeat(64)}','${operation}','${row.active ? "running" : "exited"}','${row.created}','${row.updated}')`).join(",")}`);
  const ordered = [...rows].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Date.parse(b.updated) - Date.parse(a.updated) ||
      a.configuration.localeCompare(b.configuration),
  );
  for (const [limit, count] of [
    [undefined, 256],
    [0, 1],
    [17, 17],
    [999, 256],
  ]) {
    const listed = await run(`runtime list ordering and limit ${limit}`, {
      op: "run-runtime-list",
      limit,
    });
    assert.deepEqual(
      listed.map((row) => row.id),
      ordered.slice(0, count).map((row) => row.id),
    );
  }
  const identities = await run(
    "runtime identities chronological active order",
    { op: "run-runtime-identities" },
  );
  assert.deepEqual(
    identities.map((row) => row.runtimeId),
    rows.filter((row) => row.active).map((row) => row.id),
  );
  await seed(
    "UPDATE run_configuration_runtimes SET state='running' WHERE project_id='github'",
  );
  const bounded = await run("runtime identities bounded to 256", {
    op: "run-runtime-identities",
  });
  assert.deepEqual(
    bounded.map((row) => row.runtimeId),
    rows.slice(0, 256).map((row) => row.id),
  );
  await seed(
    "DELETE FROM run_configuration_runtimes WHERE project_id='github'",
  );
  const { runRuntimeAdmissionCases } =
    await import("./run-runtime-admission-cases.mjs");
  await runRuntimeAdmissionCases({ pair, seed, report, owner, other, stamp });
}
