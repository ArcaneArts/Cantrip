// Drive both actual repositories; worker-owned paths remain opaque handles.
import assert from "node:assert/strict";
import { literal } from "./project-target-state.mjs";

export async function discoveryImportCases({
  observe,
  seed,
  snapshot,
  unchanged,
  owner,
  workspace,
  handle,
  counts,
  projectLabel,
  queue,
  status,
}) {
  const project = (n) =>
    `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
  const blind = (n) => Buffer.alloc(32, n).toString("base64url");
  const github = {
    repositoryId: handle(70),
    nameWithOwner: handle(71),
    url: handle(72),
  };
  const specs = [
    ["local", "1", "local-git"],
    ["github", "2", "github-accessible"],
    ["unclassified", "3", "unclassified"],
    ["unsupported", "4", "unsupported"],
    ["retry", "5", "local-git"],
    ["recover-one", "6", "local-git"],
    ["recover-two", "7", "local-git"],
    ["checkout-conflict", "8", "github-accessible"],
    ["github-conflict", "9", "github-accessible"],
    ["blind-conflict", "a", "github-accessible"],
    ["rollback", "b", "local-git"],
    ["identity-collision", "c", "local-git"],
  ];
  const candidates = specs.map(([tag, fingerprint, classification], i) => ({
    pathHandle: handle(10 + i * 2),
    displayHandle: handle(11 + i * 2),
    repositoryFingerprint: fingerprint.repeat(64),
    classification,
    ...(classification === "github-accessible"
      ? {
          originUrlHandle: handle(73),
          github:
            tag === "blind-conflict"
              ? {
                  repositoryId: handle(74),
                  nameWithOwner: handle(75),
                  url: handle(76),
                }
              : github,
        }
      : {}),
    ...(classification === "unsupported"
      ? { diagnosticCode: "bare-repository" }
      : {}),
  }));
  const fingerprint = (tag) =>
    candidates[specs.findIndex(([name]) => name === tag)].repositoryFingerprint;
  let state;
  const read = async (label) => (state = await observe(label, status()));
  const selected = (i, tag) =>
    state[i].candidates.find(
      (c) => c.repositoryFingerprint === fingerprint(tag),
    );
  const importInput = (i, tags, n = 1, changes = {}) => ({
    op: "discovery-import-queue",
    owner,
    workspace,
    input: {
      expectedStateRevision: state[i].job.stateRevision,
      candidates: tags.map((tag, index) => ({
        candidateId: selected(i, tag).id,
        projectId: project(n + index),
        nameProtection: projectLabel,
        ...(selected(i, tag).classification === "github-accessible"
          ? { repositoryBlindIndex: blind(n + index) }
          : {}),
      })),
      ...changes,
    },
  });
  const enqueue = async (tag, n, label = "queue " + tag) => {
    await read(label + " revision");
    const result = await observe(label, (i) => importInput(i, [tag], n));
    state = result;
    return result;
  };
  const claim = (label) => observe(label, { op: "discovery-import-claim" });
  const completion =
    (claims, changes = {}, changedClaims = {}) =>
    (i) => ({
      op: "discovery-import-complete",
      claimed: { ...claims[i], ...changedClaims },
      result: {
        candidateId: claims[i].candidateId,
        attempt: claims[i].attempt,
        repositoryFingerprint: claims[i].expectedRepositoryFingerprint,
        path: handle(
          claims[i].expectedRepositoryFingerprint === fingerprint("local")
            ? 90
            : 100 +
                Number.parseInt(claims[i].expectedRepositoryFingerprint[0], 16),
        ),
        displayPath: handle(
          claims[i].expectedRepositoryFingerprint === fingerprint("local")
            ? 91
            : 120 +
                Number.parseInt(claims[i].expectedRepositoryFingerprint[0], 16),
        ),
        originUrl: null,
        github: null,
        classification: "local-git",
        diagnosticCode: null,
        branch: "main",
        head: "a".repeat(40),
        ...changes,
      },
    });
  await read("import rejects unsucceeded scan revision");
  await observe("imports need a succeeded scan", (i) => ({
    op: "discovery-import-queue",
    owner,
    workspace,
    input: {
      expectedStateRevision: state[i].job.stateRevision,
      candidates: [],
    },
  }));
  await observe("queue scan for imports", queue());
  const scans = await observe("claim scan for imports", {
    op: "discovery-claim",
  });
  state = await observe("complete import candidate scan", (i) => ({
    op: "discovery-complete",
    job: scans[i].job.id,
    command: scans[i].commandId,
    input: {
      attempt: scans[i].job.attempt,
      candidates,
      counts: counts(candidates.length),
      truncated: false,
    },
  }));
  // A defined created-at order makes multi-row claims deterministic on either
  // actual engine without depending on random UUID order or heap layout.
  for (let i = 0; i < specs.length; i++)
    await seed(
      `UPDATE workspace_repository_candidates SET created_at=${literal(`2026-10-25T00:00:${String(i).padStart(2, "0")}.000Z`)} WHERE repository_fingerprint=${literal(candidates[i].repositoryFingerprint)}`,
    );
  await read("candidate scan retained for imports");
  for (const [label, change] of [
    ["foreign owner import", { owner: "foreign" }],
    ["missing workspace import", { workspace: "missing" }],
  ])
    await observe(label, (i) => ({ ...importInput(i, ["local"]), ...change }));
  await observe("stale import revision", (i) =>
    importInput(i, ["local"], 1, { expectedStateRevision: 1 }),
  );
  await unchanged("unknown import candidate", (i) =>
    importInput(i, ["local"], 1, {
      candidates: [
        {
          candidateId: project(99),
          projectId: project(1),
          nameProtection: projectLabel,
        },
      ],
    }),
  );
  await unchanged("duplicate direct repository candidate", (i) => {
    const request = importInput(i, ["local"]);
    request.input.candidates.push(request.input.candidates[0]);
    return request;
  });
  for (const tag of ["unclassified", "unsupported"])
    await unchanged("ineligible " + tag, (i) => importInput(i, [tag]));
  await unchanged("github requires blind identity", (i) => {
    const request = importInput(i, ["github"], 2);
    delete request.input.candidates[0].repositoryBlindIndex;
    return request;
  });
  await enqueue("local", 1);
  await unchanged("queued project identity cannot change", (i) =>
    importInput(i, ["local"], 100),
  );
  let claimed = await claim("claim local import");
  assert.equal(claimed[0].attempt, 1);
  assert.equal(claimed[0].projectId, project(1));
  await observe("running import excluded from claim", {
    op: "discovery-import-claim",
  });
  await unchanged("stale import settlement", (i) => ({
    op: "discovery-import-block",
    claimed: { ...claimed[i], commandId: "stale" },
    error: { code: "worker-offline", retryable: true },
  }));
  for (const [label, change] of [
    ["command", { commandId: "stale" }],
    ["attempt", { attempt: 99 }],
  ])
    await observe("renew stale import " + label, (i) => ({
      op: "discovery-import-renew",
      claimed: { ...claimed[i], ...change },
    }));
  await observe("renew active import", (i) => ({
    op: "discovery-import-renew",
    claimed: claimed[i],
  }));
  await snapshot("renewed import lease");
  for (const [label, change] of [
    ["attempt", { attempt: 99 }],
    ["candidate", { candidateId: project(99) }],
    ["fingerprint", { repositoryFingerprint: "f".repeat(64) }],
  ])
    await unchanged(
      "stale import completion " + label,
      completion(claimed, change),
    );
  await unchanged(
    "stale import completion command",
    completion(claimed, {}, { commandId: "stale" }),
  );
  await unchanged(
    "database prevents storage worker drift during import",
    {
      op: "sql",
      sql: `UPDATE project_workspace_storage_profiles SET worker_id='missing' WHERE workspace_id=${literal(workspace)}`,
    },
    "23514",
  );
  await observe("complete local user-owned checkout", completion(claimed));
  let rows = await snapshot("local imported catalog");
  const local = rows[0].projects.find((p) => p.id === project(1));
  assert.equal(local.origin_kind, "managed-folder");
  assert.equal(local.folder_management, "external");
  assert.equal(local.worktree_policy, "direct");
  assert.equal(local.git_capability, true);
  assert.equal(local.github_capability, false);
  const source = rows[0].sources.find((s) => s.project_id === project(1));
  assert.equal(source.ownership_kind, "user");
  assert.equal(source.placement_mode, "direct");
  assert.equal(source.absolute_path, handle(90));
  assert.equal(source.requested_path, handle(90));
  assert.equal(source.display_path, handle(91));
  const primary = rows[0].trees.find((t) => t.project_source_id === source.id);
  assert.equal(primary.name, "Primary");
  assert.equal(primary.origin, "external");
  assert.equal(primary.detached, false);
  assert.equal(primary.absolute_path, source.absolute_path);
  await read("read imported candidate");
  const beforeSkip = state[0].job.stateRevision;
  await observe("imported candidate keeps original project identity", (i) =>
    importInput(i, ["local"], 100),
  );
  await read("terminal enqueue still increments parent revision");
  assert.equal(selected(0, "local").projectId, project(1));
  assert.equal(state[0].job.stateRevision, beforeSkip + 1);
  assert.equal(selected(0, "local").displayHandle, candidates[0].displayHandle);
  await enqueue("github", 2);
  claimed = await claim("claim github import");
  await observe(
    "complete github import",
    completion(claimed, {
      classification: "github-accessible",
      originUrl: handle(73),
      github,
      branch: null,
      head: "b".repeat(40),
    }),
  );
  rows = await snapshot("github imported catalog");
  const gh = rows[0].projects.find((p) => p.id === project(2));
  assert.equal(gh.origin_kind, "github");
  assert.equal(gh.github_capability, true);
  assert.equal(gh.folder_management, null);
  assert.equal(gh.worktree_policy, "agent-managed");
  assert.equal(gh.github_repository_blind_index, blind(2));
  assert.equal(gh.github_repository_id, github.repositoryId);
  assert.equal(
    rows[0].trees.find(
      (t) =>
        t.project_source_id ===
        rows[0].sources.find((s) => s.project_id === project(2)).id,
    ).detached,
    true,
  );

  await enqueue("retry", 3);
  claimed = await claim("claim retryable import");
  await observe("block retryable import", (i) => ({
    op: "discovery-import-block",
    claimed: claimed[i],
    error: { code: "worker-offline", retryable: true },
  }));
  await observe("other worker cannot resume imports", {
    op: "discovery-import-requeue",
    worker: "other",
  });
  await observe("resume connected worker imports", {
    op: "discovery-import-requeue",
    worker: "alpha",
  });
  claimed = await claim("claim resumed import");
  assert.equal(claimed[0].attempt, 2);
  await observe("fail nonretryable import", (i) => ({
    op: "discovery-import-fail",
    claimed: claimed[i],
    error: { code: "repository-changed", retryable: false },
  }));
  const notResumed = await observe("nonretryable import stays failed", {
    op: "discovery-import-requeue",
    worker: "alpha",
  });
  assert.equal(notResumed[0], 0);

  await read("multi import admission revision");
  state = await observe("queue two recovery imports", (i) =>
    importInput(i, ["recover-one", "recover-two"], 4),
  );
  const first = await claim("claim first recovery import"),
    second = await claim("claim second recovery import");
  const unexpired = await observe("retain unexpired import leases", {
    op: "discovery-import-recover",
    force: false,
    now: new Date().toISOString(),
  });
  assert.equal(unexpired[0], 0);
  await read("recovery parent before");
  const beforeRecovery = state[0].job.stateRevision;
  const recovered = await observe("recover two imports", {
    op: "discovery-import-recover",
    force: true,
    now: new Date().toISOString(),
  });
  assert.equal(recovered[0], 2);
  await read("recovery updates parent once");
  assert.equal(state[0].job.stateRevision, beforeRecovery + 1);
  await unchanged("late pre-recovery completion", completion(first));
  const againOne = await claim("claim recovered first import"),
    againTwo = await claim("claim recovered second import");
  assert.equal(againOne[0].attempt, first[0].attempt + 1);
  assert.equal(againTwo[0].attempt, second[0].attempt + 1);
  for (const [index, claims] of [againOne, againTwo].entries())
    await observe("block recovered import " + index, (i) => ({
      op: "discovery-import-block",
      claimed: claims[i],
      error: { code: "worker-offline", retryable: true },
    }));
  await read("resume parent before");
  const beforeResume = state[0].job.stateRevision;
  const resumed = await observe("requeue two blocked imports", {
    op: "discovery-import-requeue",
    worker: "alpha",
  });
  assert.equal(resumed[0], 2);
  await read("resume updates parent once");
  assert.equal(state[0].job.stateRevision, beforeResume + 1);
  for (const n of [1, 2]) {
    const claims = await claim("claim final recovery import " + n);
    await observe("settle recovery import " + n, (i) => ({
      op: "discovery-import-block",
      claimed: claims[i],
      error: { code: "worker-offline", retryable: false },
    }));
  }

  await enqueue("checkout-conflict", 6);
  claimed = await claim("claim checkout conflict import");
  await seed(
    `UPDATE project_sources SET repository_fingerprint=${literal(fingerprint("checkout-conflict"))} WHERE project_id=${literal(project(1))}`,
  );
  await observe(
    "checkout conflict takes priority over github conflict",
    completion(claimed, {
      classification: "github-accessible",
      originUrl: handle(73),
      github,
    }),
  );
  await read("checkout conflict resolved");
  assert.equal(selected(0, "checkout-conflict").importState, "skipped");
  assert.equal(selected(0, "checkout-conflict").projectId, project(1));
  assert.equal(selected(0, "checkout-conflict").conflict.kind, "checkout");
  await enqueue("github-conflict", 7);
  claimed = await claim("claim github conflict import");
  await observe(
    "github identity conflict skips creation",
    completion(claimed, {
      classification: "github-accessible",
      originUrl: handle(73),
      github,
    }),
  );
  await read("github conflict resolved");
  assert.equal(selected(0, "github-conflict").projectId, project(2));
  assert.equal(selected(0, "github-conflict").conflict.kind, "github");
  await enqueue("blind-conflict", 2);
  claimed = await claim("claim blind identity conflict import");
  await observe(
    "blind index conflict precedes project collision",
    completion(claimed, {
      classification: "github-accessible",
      originUrl: handle(73),
      github: {
        repositoryId: handle(74),
        nameWithOwner: handle(75),
        url: handle(76),
      },
    }),
  );
  await read("blind conflict resolved");
  assert.equal(selected(0, "blind-conflict").importState, "skipped");
  assert.equal(selected(0, "blind-conflict").projectId, project(2));

  await enqueue("identity-collision", 1);
  claimed = await claim("claim conflicting requested project identity");
  await unchanged(
    "existing requested project id rolls back",
    completion(claimed),
  );
  await observe("settle project identity collision", (i) => ({
    op: "discovery-import-fail",
    claimed: claimed[i],
    error: { code: "project-conflict", retryable: false },
  }));
  await enqueue("rollback", 8);
  claimed = await claim("claim atomic catalog import");
  // Fail at the last catalog insert, after the project, membership and source
  // inserts have executed. Removing only this fixture constraint then retries
  // the exact same fenced completion; no product retry logic is replaced.
  await seed(
    `ALTER TABLE project_worktrees ADD CONSTRAINT discovery_fixture_late_failure CHECK (absolute_path<>${literal(handle(111))}) NOT VALID`,
  );
  await unchanged(
    "late Primary insert rolls back full transaction",
    completion(claimed),
    "23514",
  );
  await seed(
    "ALTER TABLE project_worktrees DROP CONSTRAINT discovery_fixture_late_failure",
  );
  await observe(
    "same completion succeeds after actual constraint removed",
    completion(claimed),
  );
  rows = await snapshot("atomic import catalog committed once");
  assert.equal(rows[0].projects.filter((p) => p.id === project(8)).length, 1);
  assert.equal(
    rows[0].sources.filter((s) => s.project_id === project(8)).length,
    1,
  );
  await unchanged(
    "duplicate completion is fenced after commit",
    completion(claimed),
  );
  await observe("queue empty rescan retaining settled imports", queue());
  const rescan = await observe("claim empty rescan", { op: "discovery-claim" });
  state = await observe(
    "scan removes only stale pending and failed candidates",
    (i) => ({
      op: "discovery-complete",
      job: rescan[i].job.id,
      command: rescan[i].commandId,
      input: {
        attempt: rescan[i].job.attempt,
        candidates: [],
        counts: counts(0),
        truncated: false,
      },
    }),
  );
  assert.equal(state[0].candidates.length, 5);
  assert.deepEqual(state[0].candidates.map((c) => c.importState).sort(), [
    "blocked",
    "blocked",
    "imported",
    "imported",
    "imported",
  ]);
  await snapshot("final import state and preserved ownership");
  await observe("foreign project removal context is absent", {
    op: "discovery-project-removal-context",
    owner: "foreign",
    project: project(1),
  });
  const context = await observe("imported external project removal context", {
    op: "discovery-project-removal-context",
    owner,
    project: project(1),
  });
  assert.equal(context[0].replicas[0].ownershipKind, "user");
  assert.equal(context[0].workspaceStorage.kind, "attached");
  assert.equal(context[0].workspaceStorage.workspaceId, workspace);
  const plan = await observe("workspace removal plans all imported projects", {
    op: "discovery-workspace-delete-plan",
    owner,
    workspace,
  });
  assert.deepEqual(plan[0].projectIds.slice().sort(), [
    project(1),
    project(2),
    project(8),
  ]);
  await seed(
    `INSERT INTO user_settings(user_id,mobile_project_tab_configurations) VALUES(${literal(owner)},'{"${project(1)}":{},"unrelated":{}}'::jsonb) ON CONFLICT(user_id) DO UPDATE SET mobile_project_tab_configurations=EXCLUDED.mobile_project_tab_configurations`,
  );
  await observe("remove imported workspace records", {
    op: "discovery-workspace-delete",
    owner,
    workspace,
  });
  rows = await snapshot("deleted workspace catalog");
  assert.equal(rows[0].projects, null);
  assert.equal(rows[0].sources, null);
  assert.equal(rows[0].trees, null);
  const settings = await observe(
    "workspace deletion removes mobile project configuration only",
    {
      op: "query-json",
      sql: `SELECT mobile_project_tab_configurations AS result FROM user_settings WHERE user_id=${literal(owner)}`,
    },
  );
  assert.deepEqual(settings[0], { unrelated: {} });
}
