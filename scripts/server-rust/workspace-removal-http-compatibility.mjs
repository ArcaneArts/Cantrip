import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { redisFixture } from "./coordinated-fixture-tools.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectSql } from "./project-administration-state.mjs";
import { label, localOwner, state } from "./project-target-state.mjs";
import { projectLabel } from "./security-fixtures.mjs";

const reference = new URL(
  "../../tests/reference-node-server/package.json",
  import.meta.url,
);
const postgres = createRequire(reference)("postgres");
const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    report: { type: "string" },
  },
});
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const redisBinary =
  values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-workspace-removal-"));
const report = { suite: "workspace-removal-terminal-revocation", cases: [] };

async function observeRemoval(fixture, sql, redis, denyPublication) {
  const workspace = denyPublication
    ? "66666666-6666-4666-8666-666666666662"
    : "66666666-6666-4666-8666-666666666661";
  const project = denyPublication ? "fault-project" : "control-project";
  const terminal = project + "-terminal";
  const envelope = projectLabel.protectedLabel.envelope;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision)
      VALUES(${workspace},${localOwner},${tx.json(envelope)},${workspace},1,1)`;
    await tx`INSERT INTO project_workspace_storage_profiles(workspace_id,kind) VALUES(${workspace},'managed')`;
    for (const query of projectSql(localOwner, project, {
      origin: "managed-folder",
      management: "external",
      membership: false,
    })) {
      await tx.unsafe(query);
    }
    await tx`INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES(${workspace},${project})`;
    await tx`INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state)
      VALUES(${terminal},${project},'alpha',${project + "-alpha-main"},${tx.json(label("terminal"))},${tx.json(state("terminal-state"))})`;
  });
  const count = async () =>
    (
      await sql`SELECT
      (SELECT count(*)::int FROM project_workspaces WHERE id=${workspace}) AS workspace,
      (SELECT count(*)::int FROM projects WHERE id=${project}) AS project,
      (SELECT count(*)::int FROM terminals WHERE id=${terminal}) AS terminal`
    )[0];
  const before = await count();
  assert.deepEqual(before, { workspace: 1, project: 1, terminal: 1 });
  if (denyPublication) {
    assert.equal(await redis.client.sendCommand(["ACL", "LOG", "RESET"]), "OK");
    assert.equal(
      await redis.client.sendCommand(["ACL", "SETUSER", "default", "-publish"]),
      "OK",
    );
  }
  let response, denials;
  try {
    const reply = await fetch(
      fixture.server.origin + "/api/workspaces/" + workspace,
      {
        method: "DELETE",
        headers: { origin: "http://127.0.0.1:5173" },
        signal: AbortSignal.timeout(15000),
      },
    );
    response = { status: reply.status, body: await reply.text() };
    denials = denyPublication
      ? await redis.client.sendCommand(["ACL", "LOG", "16"])
      : [];
  } finally {
    if (denyPublication)
      await redis.client.sendCommand(["ACL", "SETUSER", "default", "+publish"]);
  }
  const after = await count();
  const publicationDenied = denials.some((entry) => {
    const object = entry.indexOf("object");
    return object >= 0 && entry[object + 1] === "publish";
  });
  report.cases.push({
    kind: fixture.kind,
    denyPublication,
    publicationDenied,
    response,
    before,
    after,
  });
  assert.equal(publicationDenied, denyPublication);
  assert.deepEqual(response, { status: 204, body: "" });
  assert.deepEqual(after, { workspace: 0, project: 0, terminal: 0 });
}

const pg = await postgresFixture(path.join(root, "postgres"), {
  restartable: true,
});
let passed = false;
try {
  for (const kind of ["node", "rust"]) {
    const databaseUrl = await pg.database();
    const redis = await redisFixture(redisBinary, root);
    const sql = postgres(databaseUrl, { max: 1 });
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: kind,
      databaseMode: "postgres",
      environment: {
        DATABASE_URL: databaseUrl,
        REDIS_URL: redis.url,
        CANTRIP_COORDINATION_MAX_INSTANCES: "2",
        CANTRIP_SERVER_INSTANCE_ID: kind + "-workspace-removal",
      },
    });
    try {
      if (kind === "node") {
        fixture.server = await startPackagedNodeServer(
          path.join(repositoryRoot, "tests/reference-node-server"),
          fixture.environment,
          { nodeExecutable: process.execPath },
        );
      } else await fixture.start();
      const ready = await fixture.observe("shared readiness", "GET", "/readyz");
      assert.deepEqual(ready.body.coordination, {
        shared: true,
        status: "ready",
      });
      await sql`INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at)
        VALUES('alpha',${localOwner},'Local fixture','darwin','arm64',now(),now())`;
      await observeRemoval(fixture, sql, redis, false);
      await observeRemoval(fixture, sql, redis, true);
    } finally {
      try {
        await fixture.close();
      } finally {
        try {
          await sql.end({ timeout: 4 });
        } finally {
          await redis.stop();
        }
      }
    }
  }
  passed = true;
} finally {
  await pg.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  if (passed) await rm(root, { recursive: true });
  else console.error("Fixture logs retained at " + root);
}
console.log(JSON.stringify(report));
