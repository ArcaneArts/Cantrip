import assert from "node:assert/strict";

export async function inventoryCases({
  pair,
  seed,
  report,
  owner,
  other,
  stamp,
}) {
  await seed(
    `UPDATE project_worktrees SET created_at='${stamp}',updated_at='${stamp}',last_scanned_at=NULL`,
  );
  const primary = {
    path: "/fixture/github-alpha",
    isPrimary: true,
    branch: "main",
    head: "head",
    detached: false,
    locked: false,
    lockReason: null,
    missing: false,
    prunable: false,
  };
  const secondary = {
    ...primary,
    path: "/inventory-secondary",
    isPrimary: false,
    branch: "topic",
  };
  const inventory = {
    sourcePath: "distinct-source-handle",
    primaryPath: "distinct-primary-handle",
    repositoryFingerprint: "fingerprint",
    worktrees: [primary, secondary],
  };
  const created = {
    id: "inventory-created",
    name: "Chosen name",
    origin: "cantrip",
    path: secondary.path,
    lifecycleState: "creating",
  };
  const creationClocks = [new Map(), new Map()];
  async function run(label, changes = {}, error = null) {
    const input = {
      op: "inventory-reconcile",
      owner,
      project: "github",
      worker: "alpha",
      inventory,
      created,
      ...changes,
    };
    const start = Date.now(),
      results = [];
    for (const repo of pair) results.push(await repo.request(input));
    const end = Date.now();
    report.cases.push({
      label,
      input,
      expected: results[0],
      actual: results[1],
      clockWindow: [start, end],
    });
    for (const result of results) {
      assert.equal(result.rejected, error !== null, label);
      if (error) assert.equal(result.diagnostic, error, label);
    }
    const normalized = results.map((result, index) => {
      if (result.rejected)
        return { rejected: true, diagnostic: result.diagnostic };
      if (result.value === null) return null;
      return result.value.map((row) => {
        const copy = { ...row };
        for (const key of ["updatedAt", "lastScannedAt"]) {
          if (row.workerId !== "alpha") continue;
          const clock = Date.parse(row[key]);
          assert.ok(
            clock >= start && clock <= end,
            `${label}: ${row.id}.${key} is actual transaction clock`,
          );
          copy[key] = "verified-transaction-clock";
        }
        if (row.id === "inventory-created") {
          if (!creationClocks[index].has(row.id)) {
            assert.ok(
              Date.parse(row.createdAt) >= start &&
                Date.parse(row.createdAt) <= end,
            );
            creationClocks[index].set(row.id, row.createdAt);
          } else assert.equal(row.createdAt, creationClocks[index].get(row.id));
          copy.createdAt = "verified-retained-creation-clock";
        } else assert.equal(row.createdAt, stamp);
        return copy;
      });
    });
    assert.deepEqual(normalized[1], normalized[0], label);
    return normalized[0];
  }
  assert.equal(await run("inventory foreign owner", { owner: other }), null);
  assert.equal(
    await run("inventory foreign worker", { worker: "foreign" }),
    null,
  );
  await run(
    "inventory folder rejected",
    { project: "folder" },
    "Git worktree reconciliation is unavailable for folder sources.",
  );
  await run(
    "inventory without Primary",
    { inventory: { ...inventory, worktrees: [secondary] } },
    "Worker inventory did not contain exactly one Primary.",
  );
  await run(
    "inventory duplicate Primary",
    { inventory: { ...inventory, worktrees: [primary, primary] } },
    "Worker inventory did not contain exactly one Primary.",
  );
  await run(
    "inventory different source",
    { inventory: { ...inventory, worktrees: [{ ...primary, path: "wrong" }] } },
    "Worker inventory referred to a different replica path.",
  );
  const first = await run("inventory creates and preserves identity");
  assert.equal(first.find((row) => row.id === created.id).name, "Chosen name");
  assert.equal(
    first.find((row) => row.id === created.id).lifecycleState,
    "ready",
  );
  await run(
    "inventory fingerprint mismatch",
    { inventory: { ...inventory, repositoryFingerprint: "other" } },
    "Worker inventory belongs to a different Git common directory.",
  );
  const retained = await run("inventory preserves name origin and default", {
    created: { ...created, name: "Ignored", origin: "external" },
  });
  assert.equal(
    retained.find((row) => row.id === created.id).name,
    "Chosen name",
  );
  const missing = await run("inventory missing secondary", {
    inventory: { ...inventory, worktrees: [primary] },
  });
  assert.equal(
    missing.find((row) => row.id === created.id).lifecycleState,
    "missing",
  );
  const prunable = await run("inventory observed prunable", {
    inventory: {
      ...inventory,
      worktrees: [primary, { ...secondary, prunable: true }],
    },
  });
  assert.equal(
    prunable.find((row) => row.id === created.id).lifecycleState,
    "prunable",
  );
  const both = await run("inventory missing takes precedence", {
    inventory: {
      ...inventory,
      worktrees: [primary, { ...secondary, prunable: true, missing: true }],
    },
  });
  assert.equal(
    both.find((row) => row.id === created.id).lifecycleState,
    "missing",
  );
  // Fail the INSERT after the source and Primary updates have executed. The
  // entire transaction must roll back, including timestamps and Git fields.
  const snapshots = [];
  const snapshot = {
    op: "query-json",
    sql: "SELECT jsonb_build_object('sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM project_sources s),'worktrees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_worktrees w)) result",
  };
  for (const repo of pair) {
    const before = await repo.request(snapshot);
    assert.equal(before.rejected, false);
    const rejected = await repo.request({
      op: "inventory-reconcile",
      owner,
      project: "github",
      worker: "alpha",
      inventory: {
        ...inventory,
        worktrees: [
          { ...primary, branch: "must-roll-back", locked: true },
          { ...secondary, path: "/conflicting-new-path" },
        ],
      },
      created: {
        ...created,
        id: "github-beta-main",
        path: "/conflicting-new-path",
      },
    });
    assert.equal(
      rejected.rejected,
      true,
      "existing foreign-source id must fail insertion",
    );
    const after = await repo.request(snapshot);
    assert.equal(after.rejected, false);
    assert.deepEqual(
      after.value,
      before.value,
      "inventory failure rolls back all database writes",
    );
    snapshots.push({ before, rejected, after });
  }
  report.cases.push({
    label: "inventory insertion failure is atomic",
    snapshots,
  });
}
