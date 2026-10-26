// Real database/repository evidence for scope authorization; not HTTP acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const binary = await buildRustExample("project-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-repository-"));
const owner = "00000000-0000-0000-0000-000000000001",
  other = "11111111-1111-4111-8111-111111111111";
const stamp = "2026-10-25T00:00:00.123Z";
const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
let postgresOwner, failure;
const pair = [],
  report = {
    suite: "project-repository-differential",
    databaseMode,
    completeReplacement: false,
    scope:
      "Actual connectors, SQL and repository mapping; HTTP/session/product acceptance remains separate",
    cases: [],
    databaseCases: [],
  };
async function seed(sql) {
  for (const fixture of pair) await fixture.seed(sql);
}
async function visit(label, ownerRejected = false) {
  for (const principal of [owner, other, "unowned"]) {
    const expected = await pair[0].request({ op: "list", owner: principal }),
      actual = await pair[1].request({ op: "list", owner: principal });
    assert.equal(
      expected.rejected,
      principal === owner ? ownerRejected : false,
      `Reference scenario must exercise its intended outcome: ${label}/${principal}`,
    );
    const observation = (v) =>
      v.rejected ? { rejected: true } : { rejected: false, value: v.value };
    try {
      assert.deepEqual(
        observation(actual),
        observation(expected),
        `${label}/${principal}`,
      );
    } catch (error) {
      report.failure = { label, principal, actual, expected };
      throw error;
    }
    report.cases.push({
      label,
      owner: principal,
      rejected: expected.rejected,
      projects: expected.value?.length,
    });
  }
}
async function negative(label, sql) {
  const expected = await pair[0].request({ op: "sql", sql }),
    actual = await pair[1].request({ op: "sql", sql });
  assert.equal(
    actual.rejected,
    expected.rejected,
    `${label}: database constraint behavior`,
  );
  report.databaseCases.push({ label, rejected: expected.rejected });
  await visit(
    expected.rejected ? `${label} rejected by database` : label,
    !expected.rejected,
  );
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"])
    pair.push(
      await repositoryFixture({
        kind,
        executable: binary,
        root,
        databaseMode,
        databaseUrl:
          postgresOwner && (kind === "node" || databaseMode === "postgres")
            ? await postgresOwner.database()
            : undefined,
      }),
    );
  await visit("empty owner catalogs");
  await seed(
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES (${literal(other)},'account','Other fixture owner','member','active','other@example.invalid','other@example.invalid');`,
  );
  for (const [id, origin, folder, git, github, position, projectOwner] of [
    ["project-one", "github", null, true, true, 0, owner],
    ["project-folder", "managed-folder", "external", false, false, 1, owner],
    ["project-local-git", "managed-folder", "managed", true, false, 2, owner],
    ["project-other", "github", null, true, true, 0, other],
  ])
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,position,origin_kind,folder_management,git_capability,github_capability,worktree_policy,github_repository_blind_index,created_at,updated_at) VALUES (${literal(id)},${literal(projectOwner)},${json(projectLabel)},${position},${literal(origin)},${literal(folder)},${git},${github},${literal(origin === "github" ? "agent-managed" : "direct")},${literal(origin === "github" ? "fixture-blind-index" : null)},${literal(stamp)},${literal(stamp)});`,
    );
  await visit("all project origin/capability combinations and owner isolation");
  const ids = [
    "Source-z",
    "source-A",
    "é",
    "e\u0301",
    "I",
    "i",
    "ı",
    "İ",
    "file-10",
    "file-2",
    "_source",
    "-source",
  ];
  for (const [index, id] of ids.entries()) {
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,created_at,updated_at) VALUES ('worker-${index}',${literal(owner)},'Fixture worker ${index}','linux','x64',${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)});`,
    );
    await seed(
      `INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path,created_at,updated_at) VALUES (${literal(id)},'project-one','worker-${index}','/fixture/source-${index}','/fixture/source-${index}',${literal(stamp)},${literal(stamp)});`,
    );
  }
  await visit("replicas without primary worktrees retain locale ordering");
  for (const [index, id] of ids.entries())
    await seed(
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,head,created_at,updated_at) VALUES ('worktree-${index}',${literal(id)},'worker-${index}','main','/fixture/source-${index}','/fixture/source-${index}',true,'cantrip',${literal(index % 2 ? "ready" : "creating")},'stored-branch','stored-head',${literal(stamp)},${literal(stamp)});`,
    );
  await visit("ready replicas precede not-ready replicas");
  await seed("UPDATE workers SET started_at='infinity' WHERE id='worker-0';");
  await visit(
    "worker summary still validates startedAt when only name and online are projected",
    true,
  );
  await seed(
    `UPDATE workers SET started_at=${literal(stamp)} WHERE id='worker-0';`,
  );
  await seed(
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,status_observed_at,created_at,updated_at) VALUES ('nonprimary','Source-z','worker-0','secondary','/fixture/secondary','/fixture/secondary',false,'cantrip','ready','infinity',${literal(stamp)},${literal(stamp)});`,
  );
  await visit("unused nonprimary observation timestamp is not serialized");
  await seed("DELETE FROM project_worktrees WHERE id='nonprimary';");
  await seed(
    "UPDATE projects SET preferred_worker_id='worker-0' WHERE id='project-one';",
  );
  await visit("not-ready preference falls back to first ready");
  await seed(
    "UPDATE projects SET preferred_worker_id='worker-3' WHERE id='project-one';",
  );
  await visit("preferred ready source selected independently of replica order");
  await seed(
    `UPDATE workers SET unlinked_at=${literal(stamp)},display_name='Retained display name' WHERE id='worker-3';`,
  );
  await visit(
    "retained unlinked worker still participates in project source mapper",
  );
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE worker_id='worker-3';`,
  );
  await visit("removed source excluded despite preference");
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE worker_id='worker-3';",
  );
  for (const [label, status] of [
    [
      "observed branch and dirty files",
      { branch: "observed", head: "observed-head", files: [{}] },
    ],
    [
      "null observed fields use stored values",
      { branch: null, head: null, files: [] },
    ],
    ["false observation", false],
    ["zero observation", 0],
    ["string file length uses UTF16", { files: "🦀" }],
    [
      "object file length coerces like JavaScript",
      { files: { length: "0x2" } },
    ],
    ["missing length is not dirty", { files: {} }],
    ["missing files rejects catalog", {}],
    ["null files rejects catalog", { files: null }],
    ["numeric observed branch rejects catalog", { files: [], branch: 0 }],
    ["empty observed head rejects catalog", { files: [], head: "" }],
  ]) {
    await seed(
      `UPDATE project_worktrees SET status_snapshot=${json({ status })},status_observed_at=${literal(stamp)} WHERE id='worktree-3';`,
    );
    await visit(
      label,
      [
        "missing files rejects catalog",
        "null files rejects catalog",
        "numeric observed branch rejects catalog",
        "empty observed head rejects catalog",
      ].includes(label),
    );
  }
  await seed(
    "UPDATE project_worktrees SET status_snapshot=NULL,status_observed_at=NULL WHERE id='worktree-3';",
  );
  const invalidLabel = structuredClone(projectLabel);
  invalidLabel.classification.recordKind = "chat";
  const invalidEnvelope = structuredClone(projectLabel);
  invalidEnvelope.protectedLabel.envelope.keyRevision = 2;
  for (const [label, column, value] of [
    [
      "wrong encrypted-label classification",
      "protected_label",
      json(invalidLabel),
    ],
    [
      "mismatched label envelope metadata",
      "protected_label",
      json(invalidEnvelope),
    ],
    [
      "folder metadata contradicts GitHub origin",
      "folder_management",
      literal("managed"),
    ],
    ["negative project position", "position", "-1"],
    ["empty setup error", "setup_error", literal("")],
    ["unknown worktree policy", "worktree_policy", literal("unknown")],
  ]) {
    await negative(
      label,
      `UPDATE projects SET ${column}=${value} WHERE id='project-one';`,
    );
    await seed(
      `UPDATE projects SET protected_label=${json(projectLabel)},folder_management=NULL,position=0,setup_error=NULL,worktree_policy='agent-managed' WHERE id='project-one';`,
    );
  }
  await seed(
    "UPDATE projects SET git_capability=false,github_capability=false WHERE id='project-one';",
  );
  await visit("GitHub origin capabilities override stored false flags");
  await seed(
    "UPDATE projects SET github_capability=true WHERE id='project-folder';",
  );
  await visit(
    "GitHub capability without Git rejects only the affected owner",
    true,
  );
  await seed(
    "UPDATE projects SET github_capability=false WHERE id='project-folder';",
  );
  await seed(
    "UPDATE projects SET github_repository_id='repo',github_repository_full_name='ArcaneArts/Cantrip',github_repository_url='  https://github.com/ArcaneArts/Cantrip  ' WHERE id='project-one';",
  );
  await visit("repository URL output is trimmed through actual schema");
  await seed(
    "UPDATE projects SET github_repository_url='not a URL' WHERE id='project-one';",
  );
  await visit("invalid stored GitHub URL rejects catalog", true);
  await seed(
    "UPDATE projects SET github_repository_id=NULL,github_repository_full_name=NULL,github_repository_url=NULL WHERE id='project-one';",
  );
  await visit("recovered valid catalog");
} catch (error) {
  failure = error;
  report.error = error.message;
} finally {
  const cleanups = await Promise.allSettled(pair.map((f) => f.close()));
  const errors = cleanups
    .filter((v) => v.status === "rejected")
    .map((v) => v.reason);
  try {
    await postgresOwner?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Repository scenario/cleanup failure",
    );
  await rm(root, { recursive: true, force: true });
  if (failure) report.error = failure.message;
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        suite: report.suite,
        databaseMode,
        cases: report.cases.length,
        rejections: report.cases.filter((c) => c.rejected).length,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
