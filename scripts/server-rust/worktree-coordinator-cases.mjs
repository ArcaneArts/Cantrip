import assert from "node:assert/strict";

export async function worktreeCoordinatorCases({
  pair,
  seed,
  report,
  owner,
  other,
  stamp,
}) {
  const id = "44444444-4444-4444-8444-444444444444";
  const primary = {
    path: "/fixture/github-alpha",
    head: "head",
    branch: "main",
    detached: false,
    isPrimary: true,
    managed: true,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  };
  const secondary = {
    ...primary,
    path: "/coordinator-created",
    isPrimary: false,
    branch: "topic",
  };
  const inventory = {
    sourcePath: primary.path,
    primaryPath: primary.path,
    gitCommonDir: "/git",
    managedRoot: "/managed",
    repositoryFingerprint: "a".repeat(64),
    worktrees: [primary, secondary],
  };
  const input = {
    name: "Created name",
    origin: "cantrip",
    worktreeId: id,
    mode: { type: "newBranch", branch: "topic", startPoint: null },
  };
  const success = { created: true, worktree: secondary, inventory };
  const invalidInventory = {
    ...inventory,
    worktrees: [{ ...primary, path: "/wrong-source" }, secondary],
  };
  const failedReconcile = { ...success, inventory: invalidInventory };
  const removed = {
    removedPath: secondary.path,
    inventory: { ...inventory, worktrees: [primary] },
  };
  async function run(label, changes, expectedOutcome, commands) {
    await seed(`DELETE FROM project_worktrees WHERE id='${id}'`);
    await seed(
      "UPDATE project_sources SET absolute_path='/fixture/github-alpha',repository_fingerprint=NULL,removed_at=NULL WHERE id='github-alpha'",
    );
    await seed(
      `UPDATE project_worktrees SET lifecycle_state='ready',absolute_path='/fixture/github-alpha',created_at='${stamp}',updated_at='${stamp}',last_scanned_at=NULL WHERE id='github-alpha-main'`,
    );
    const request = {
      op: "worktree-coordinator",
      owner,
      project: "github",
      action: "create",
      input,
      replies: [{ value: success }],
      ...changes,
    };
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
    const normalized = results.map((result) => {
      assert.equal(result.rejected, false, label);
      const value = structuredClone(result.value);
      assert.equal(
        value.trace.filter((x) => x.command).length,
        commands,
        label,
      );
      if (expectedOutcome) {
        assert.equal(value.error.mutation.outcome, expectedOutcome, label);
        assert.equal(value.trace.filter((x) => x.changed).length, 0);
      } else {
        assert.equal(value.error, undefined, label);
        assert.equal(value.trace.filter((x) => x.changed).length, 1);
      }
      for (const row of value.value == null
        ? []
        : Array.isArray(value.value)
          ? value.value
          : [value.value]) {
        for (const key of ["createdAt", "updatedAt", "lastScannedAt"]) {
          if (
            row[key] === null ||
            row[key] === stamp ||
            row.workerId !== "alpha"
          )
            continue;
          assert.ok(
            Date.parse(row[key]) >= start && Date.parse(row[key]) <= end,
            `${label} ${key}`,
          );
          row[key] = "verified-operation-clock";
        }
      }
      return value;
    });
    assert.deepEqual(normalized[1], normalized[0], label);
    const stored = [];
    for (const repo of pair) {
      const snapshot = await repo.request({
        op: "query-json",
        sql: `SELECT to_jsonb(w)-'created_at'-'updated_at'-'last_scanned_at' result FROM project_worktrees w WHERE id='${id}'`,
      });
      assert.equal(snapshot.rejected, false);
      stored.push(snapshot.value);
    }
    assert.deepEqual(stored[1], stored[0], `${label}: durable catalog`);
    report.cases.at(-1).catalog = stored;
    return { result: normalized[0], stored: stored[0] };
  }
  const created = await run("coordinator creates and reconciles", {}, null, 1);
  assert.equal(created.stored.name, input.name);
  assert.equal(created.stored.origin, "cantrip");
  await run(
    "coordinator explicit source",
    { input: { ...input, sourceWorktreeId: "github-alpha-main" } },
    null,
    1,
  );
  await run("coordinator foreign owner", { owner: other }, "notStarted", 0);
  await run(
    "coordinator missing requested source",
    { input: { ...input, sourceWorktreeId: "missing" } },
    "notStarted",
    0,
  );
  await run(
    "coordinator worker failure is ambiguous",
    { replies: [{ error: "Worker disconnected" }] },
    "partial",
    1,
  );
  await run(
    "coordinator malformed create result is ambiguous",
    { replies: [{ value: { created: true } }] },
    "partial",
    1,
  );
  await run(
    "coordinator user creation stays untouched",
    {
      input: { ...input, origin: "user" },
      replies: [{ value: failedReconcile }],
    },
    "partial",
    1,
  );
  await run(
    "coordinator preexisting creation stays untouched",
    { replies: [{ value: { ...failedReconcile, created: false } }] },
    "partial",
    1,
  );
  const rollback = await run(
    "coordinator verified rollback",
    { replies: [{ value: failedReconcile }, { value: removed }] },
    "rolledBack",
    2,
  );
  assert.equal(rollback.stored, null);
  await run(
    "coordinator rollback wrong path",
    {
      replies: [
        { value: failedReconcile },
        { value: { ...removed, removedPath: "wrong" } },
      ],
    },
    "partial",
    2,
  );
  await run(
    "coordinator rollback still inventoried",
    {
      replies: [
        { value: failedReconcile },
        { value: { ...removed, inventory } },
      ],
    },
    "partial",
    2,
  );
  await run(
    "coordinator rollback worker failure",
    { replies: [{ value: failedReconcile }, { error: "Removal failed" }] },
    "partial",
    2,
  );
  const preserved = await run(
    "coordinator rollback refuses changed catalog binding",
    {
      replies: [
        { value: failedReconcile },
        {
          value: removed,
          sql: `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('${id}','github-alpha','alpha','preserved','/different-path','/different-path',false,'cantrip','ready')`,
        },
      ],
    },
    "partial",
    2,
  );
  assert.equal(preserved.stored.absolute_path, "/different-path");
  const reconciled = await run(
    "coordinator reconcile inventory",
    {
      action: "reconcile",
      replies: [{ value: { ...inventory, worktrees: [primary] } }],
    },
    null,
    1,
  );
  assert.ok(reconciled.result.value.some((w) => w.id === "github-alpha-main"));
  await seed(`DELETE FROM project_worktrees WHERE id='${id}'`);
  const sha = "a".repeat(40);
  const pullRequest = {
    number: 7,
    title: "Checkout",
    state: "open",
    url: "https://example.invalid/pull/7",
    author: "author",
    commentCount: 0,
    labels: [],
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    body: null,
    draft: false,
    merged: false,
    headRef: "main",
    headSha: sha,
    baseRef: "base",
    baseSha: "b".repeat(40),
  };
  const prepared = {
    pullRequest,
    branch: "main",
    name: "Checkout name",
    headSha: sha,
    remote: "origin",
  };
  await seed(
    `UPDATE project_worktrees SET branch='main',head='${sha}',lifecycle_state='ready',created_at='${stamp}',updated_at='${stamp}',last_scanned_at=NULL WHERE id='github-alpha-main'`,
  );
  await seed(
    "UPDATE project_worktrees SET branch='other-worker-branch' WHERE id='github-beta-main'",
  );
  for (const [label, changes, expectedError] of [
    ["checkout reuses matching worktree", {}, null],
    [
      "checkout rejects different head",
      { replies: [{ value: { ...prepared, headSha: "b".repeat(40) } }] },
      "The checkout branch main already belongs to a different or unavailable worktree.",
    ],
    [
      "checkout rejects another worker branch",
      { replies: [{ value: { ...prepared, branch: "other-worker-branch" } }] },
      "The checkout branch other-worker-branch already belongs to a different or unavailable worktree.",
    ],
    [
      "checkout missing source",
      { sourceWorktreeId: "missing", replies: [] },
      null,
    ],
  ]) {
    const request = {
      op: "worktree-coordinator",
      owner,
      project: "github",
      action: "checkout",
      sourceWorktreeId: "github-alpha-main",
      repository: "org/repository",
      number: 7,
      replies: [{ value: prepared }],
      ...changes,
    };
    const results = [];
    for (const repo of pair) results.push(await repo.request(request));
    report.cases.push({
      label,
      request,
      expected: results[0],
      actual: results[1],
    });
    for (const result of results) {
      assert.equal(result.rejected, false);
      assert.equal(
        result.value.error?.message,
        expectedError ?? undefined,
        label,
      );
      assert.equal(
        result.value.trace.filter((e) => e.changed).length,
        expectedError ? 0 : 1,
      );
      if (!expectedError && request.sourceWorktreeId !== "missing") {
        assert.equal(result.value.value.reused, true);
        assert.equal(result.value.value.worktree.id, "github-alpha-main");
        assert.equal(
          result.value.trace.filter((e) => e.command).length,
          1,
          "reuse must not create a worktree",
        );
      } else if (request.sourceWorktreeId === "missing")
        assert.equal(result.value.value, null);
    }
    assert.deepEqual(results[1].value, results[0].value, label);
  }
  const freshRequest = {
    op: "worktree-coordinator",
    owner,
    project: "github",
    action: "checkout",
    sourceWorktreeId: "github-alpha-main",
    repository: "org/repository",
    number: 7,
    replies: [
      { value: { ...prepared, branch: "topic" } },
      {
        value: {
          ...success,
          worktree: { ...secondary, head: sha },
          inventory: {
            ...inventory,
            worktrees: [primary, { ...secondary, head: sha }],
          },
        },
      },
    ],
  };
  const start = Date.now(),
    freshResults = [];
  for (const repo of pair) freshResults.push(await repo.request(freshRequest));
  const end = Date.now();
  const normalized = freshResults.map((result) => {
    assert.equal(result.rejected, false);
    assert.equal(result.value.error, undefined);
    const value = structuredClone(result.value),
      row = value.value.worktree;
    assert.equal(value.value.reused, false);
    assert.match(
      row.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(row.origin, "user");
    assert.equal(row.name, prepared.name);
    assert.equal(row.head, sha);
    const commands = value.trace.filter((e) => e.command);
    assert.equal(commands.length, 2);
    assert.equal(commands[1].command.type, "worktree.create");
    assert.equal(commands[1].command.worktreeId, row.id);
    assert.deepEqual(commands[1].command.mode, {
      type: "newBranch",
      branch: "topic",
      startPoint: sha,
    });
    assert.equal(value.trace.filter((e) => e.changed).length, 1);
    row.id = "verified-generated-id";
    commands[1].command.worktreeId = row.id;
    for (const key of ["createdAt", "updatedAt", "lastScannedAt"]) {
      assert.ok(Date.parse(row[key]) >= start && Date.parse(row[key]) <= end);
      row[key] = "verified-operation-clock";
    }
    return value;
  });
  assert.deepEqual(
    normalized[1],
    normalized[0],
    "checkout creates a user-owned worktree",
  );
  report.cases.push({
    label: "checkout creates user worktree",
    request: freshRequest,
    expected: freshResults[0],
    actual: freshResults[1],
    clockWindow: [start, end],
  });
  await seed(
    "DELETE FROM project_worktrees WHERE absolute_path='/coordinator-created'",
  );
}
