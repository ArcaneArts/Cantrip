// Protected import and real background execution while the enrolled worker is offline.
import { setTimeout as delay } from "node:timers/promises";
import { replicaConnectedCases } from "./replica-connected-cases.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password, heartbeat, projectLabel } from "./security-fixtures.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { provisioningStateReopen } from "./provisioning-state-reopen.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-replica-import-http-"));
const report = {
  suite: "replica-import-http",
  databaseMode,
  root,
  profiles: [],
  completeReplacement: false,
  connected: process.argv.includes("--connected"),
  faults: process.argv.includes("--faults"),
  reconnect: process.argv.includes("--reconnect"),
  leaseRecovery: process.argv.includes("--lease-recovery"),
  shutdown: process.argv.includes("--shutdown"),
  convertedRemoval: process.argv.includes("--converted-removal"),
  concurrency: process.argv.includes("--concurrency"),
};
const id = "33333333-3333-4333-8333-000000000001";
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (profile) => !option("--profile") || option("--profile") === profile,
  )) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const observations = [];
      const admissions = [];
      runtimes.push({ kind, observations, admissions, startedAt: Date.now() });
      const visit = async (label, method, route, options = {}) => {
        const observation = {
          label,
          ...(await fixture.observe(label, method, route, {
            csrf: method === "POST" && !!fixture.client().csrf,
            ...options,
          })),
        };
        observations.push(observation);
        const match =
          typeof route === "string" &&
          route.match(
            /^\/api\/projects\/([^/]+)\/replicas\/([^/]+)\/(synchronize|remove)$/,
          );
        if (method === "POST" && observation.status === 202 && match)
          admissions.push({
            jobId: fixture.records.get(label).id,
            projectId: match[1],
            replicaId: match[2],
            kind: match[3],
            input: structuredClone(options.json),
          });
      };
      try {
        await fixture.start();
        if (profile === "accounts")
          await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "replicas@example.invalid",
              displayName: "Replicas",
              password,
            },
          });
        else if (profile === "password")
          await visit("login", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        const handle = (n) =>
          "ctrr_" + Buffer.alloc(32, n).toString("base64url");
        const input = {
          id,
          workerId: "import-worker",
          nameProtection: projectLabel,
          repositoryBlindIndex: Buffer.alloc(32, 1).toString("base64url"),
          repositoryId: handle(1),
          nameWithOwner: handle(2),
          url: handle(3),
        };
        const create = (label, extra = {}, status = 202) =>
          visit(label, "POST", "/api/projects/from-github", {
            status,
            json: { ...input, ...extra },
          });
        await visit("invalid import", "POST", "/api/projects/from-github", {
          status: 400,
          json: {},
        });
        await create("unknown worker", {}, 404);
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Import worker" } },
        );
        await visit("enroll", "POST", "/api/internal/workers/enroll", {
          status: 201,
          client: "worker",
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: {
              ...heartbeat,
              workerId: "import-worker",
              projectReplicas: {
                ...heartbeat.projectReplicas,
                provision: true,
                exactRevision: true,
              },
            },
          },
        });
        await create(
          "unsupported placement",
          { placement: { mode: "direct", path: handle(4) } },
          409,
        );
        await create(
          "unknown workspace",
          { workspaceId: "missing-workspace" },
          400,
        );
        await create("import");
        const project = fixture.records.get("import");
        assert.equal(project.setupStatus, "cloning");
        assert.deepEqual(project.replicas, []);
        assert.deepEqual(project.nameProtection, projectLabel);
        assert.deepEqual(project.github, {
          repositoryId: input.repositoryId,
          nameWithOwner: input.nameWithOwner,
          url: input.url,
        });
        const jobsPath = `/api/projects/${id}/replica-jobs`;
        const waitBlocked = async (attempt) => {
          const until = Date.now() + 20000;
          for (;;) {
            const response = await fetch(fixture.server.origin + jobsPath, {
              headers: {
                cookie: [...fixture.client().cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; "),
              },
            });
            assert.equal(response.status, 200);
            const jobs = await response.json();
            if (
              jobs.length === 1 &&
              jobs[0].state === "blocked" &&
              jobs[0].attempt === attempt
            )
              return jobs[0];
            assert.ok(Date.now() < until, JSON.stringify(jobs));
            await delay(20);
          }
        };
        let job = await waitBlocked(1);
        assert.deepEqual(job.error, {
          code: "worker-offline",
          retryable: true,
        });
        await visit("blocked jobs", "GET", jobsPath);
        await visit("project after block", "GET", "/api/projects");
        assert.equal(
          fixture.records
            .get("project after block")
            .find((project) => project.id === id).setupStatus,
          "failed",
        );
        await create(
          "duplicate despite missing worker",
          { workerId: "missing" },
          409,
        );
        await visit(
          "stale retry",
          "POST",
          `/api/project-replica-jobs/${job.id}/retry`,
          { status: 409, json: { stateRevision: job.stateRevision + 1 } },
        );
        await visit(
          "retry",
          "POST",
          `/api/project-replica-jobs/${job.id}/retry`,
          { json: { stateRevision: job.stateRevision } },
        );
        job = await waitBlocked(2);
        await visit("blocked twice", "GET", jobsPath);
        await visit(
          "cancel",
          "POST",
          `/api/project-replica-jobs/${job.id}/cancel`,
          { json: { stateRevision: job.stateRevision } },
        );
        await visit("cancelled jobs", "GET", jobsPath);
        assert.equal(
          fixture.records.get("cancelled jobs")[0].state,
          "cancelled",
        );
        await fixture.close();
        await fixture.start();
        await visit("cancelled after restart", "GET", jobsPath);
        await create("duplicate after restart", {}, 409);
        if (report.connected)
          runtimes.at(-1).connected = await replicaConnectedCases({
            fixture,
            visit,
            root,
            profile,
            kind,
            id,
          });
      } catch (error) {
        runtimes.at(-1).diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        runtimes.at(-1).replicaShutdownStages = fixture.replicaShutdownStages;
        await fixture.close();
      }
      if (process.argv.includes("--canonical-state"))
        runtimes.at(-1).durableState = await provisioningStateReopen({
          fixture,
          root,
          profile,
          startedAt: runtimes.at(-1).startedAt,
          admissions,
        });
    }
    assert.deepEqual(runtimes[1].observations, runtimes[0].observations);
    if (report.connected)
      assert.deepEqual(runtimes[1].connected, runtimes[0].connected);
    if (process.argv.includes("--canonical-state"))
      assert.deepEqual(
        runtimes[1].durableState.canonical,
        runtimes[0].durableState.canonical,
        profile + ": complete project/job persistence",
      );
  }
  report.passed = true;
} catch (e) {
  failure = e;
  report.failure = e.stack;
} finally {
  await pg?.close();
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
  else report.retainedRoot = root;
  if (option("--report"))
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify(report));
