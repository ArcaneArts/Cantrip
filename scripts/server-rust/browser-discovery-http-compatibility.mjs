// Compare real HTTP and actual worker sockets; no injected bridge or shortened timeout.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
} from "./project-target-state.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { password } from "./security-fixtures.mjs";
import {
  DiscoveryWorkers,
  discoveryStateSql,
  connectedIds,
} from "./browser-discovery-worker.mjs";
import { eventually } from "./full-worker.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-browser-discovery-"));
const report = {
  suite: "actual-browser-service-discovery",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
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
          CANTRIP_ACCOUNT_COMMAND_CONCURRENCY: "128",
          CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE: "10000",
          CANTRIP_WORKER_COMMAND_CONCURRENCY: "128",
          CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE: "10000",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        observations: [],
        commands: [],
        dispatches: [],
        stored: [],
      };
      runtimes.push(result);
      let repo, live, workers;
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const visit = async (name, method, url, options = {}) => {
        const observation = await fixture.observe(name, method, url, {
          timeoutMs: 30000,
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...observation });
        return fixture.records.get(name);
      };
      const get = async (name, url, options = {}) => {
        await workers?.refresh();
        const start = result.commands.length;
        const value = await visit(name, "GET", url, options);
        const dispatches = result.commands
          .slice(start)
          .map((c) => {
            assert.deepEqual(c.command, { type: "browser.services.discover" });
            return c.workerId;
          })
          .sort();
        result.dispatches.push({ name, workers: dispatches });
        return value;
      };
      const stored = async () => {
        const value = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('browsers',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM browsers b),'surfaces',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM remote_surfaces s)) result",
        });
        assert.equal(value.rejected, false, value.diagnostic);
        result.stored.push(fixture.normalize(value.value));
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `discovery-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of [
          ...targetStateSql(owner, other),
          ...discoveryStateSql(owner),
        ])
          await repo.seed(sql);
        await stored();
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("read-only browser discovery", [
          currentUser,
          { kind: "project", projectId: "github" },
        ]);
        for (const project of ["missing", "other"])
          await get(
            "missing project " + project,
            `/api/projects/${project}/browser-services`,
            { status: 404 },
          );
        for (const browser of ["missing", "other-browser", "desktop", "remote"])
          await get(
            "missing browser " + browser,
            `/api/browsers/${browser}/services`,
            { status: 404 },
          );
        await get("offline browser", "/api/browsers/browser/services", {
          status: 503,
        });
        const offline = await get(
          "bounded offline fleet",
          "/api/projects/github/browser-services",
          { status: 200 },
        );
        assert.equal(offline.workers.length, 64);
        assert.equal(offline.partial, true);
        assert.equal(offline.truncated, true);
        assert.ok(
          offline.workers.every(
            (w) => w.status === "offline" && w.services.length === 0,
          ),
        );
        assert.ok(
          !offline.workers.some((w) =>
            ["foreign", "not-browser", "unlinked-browser"].includes(w.workerId),
          ),
        );
        const boundary = offline.workers.find((w) => w.workerId === "�");
        assert.equal(boundary.workerName.length, 200);
        assert.equal(boundary.workerName.charCodeAt(199), 0xd83e);
        const empty = await get(
          "no eligible worker",
          "/api/projects/empty-folder/browser-services",
          { status: 200 },
        );
        assert.deepEqual(empty.workers, []);
        assert.equal(empty.partial, false);
        assert.equal(empty.truncated, false);
        workers = new DiscoveryWorkers({
          fixture,
          root: path.join(root, profile, kind, "workers"),
          visit,
          result,
        });
        for (const id of connectedIds) await workers.enroll(id);
        const single = await get(
          "authenticated worker identity",
          "/api/browsers/browser/services",
          { status: 200 },
        );
        assert.equal(single[0].workerId, "alpha");
        assert.equal(single[0].host, "127.0.0.1");
        assert.equal(single[0].title, "Development");
        assert.equal(single[0].ignored, undefined);
        await get("raw browser context", "/api/browsers/raw-browser/services", {
          status: 200,
        });
        const local = await get(
          "local Git ready replicas",
          "/api/projects/local-git/browser-services",
          { status: 200 },
        );
        assert.deepEqual(
          local.workers.map((w) => w.workerId),
          ["beta", "alpha"],
        );
        assert.equal(local.partial, false);
        const folder = await get(
          "bound folder owner",
          "/api/projects/folder/browser-services",
          { status: 200 },
        );
        assert.deepEqual(
          folder.workers.map((w) => w.workerId),
          ["alpha"],
        );
        assert.equal(folder.partial, false);
        for (const worker of local.workers)
          for (const s of worker.services)
            assert.deepEqual(s.placement, {
              projectId: "local-git",
              workerId: worker.workerId,
              projectReplicaId: null,
              worktreeId: null,
              surface: null,
            });
        for (const mode of [
          "trimmed-url",
          "bad-url",
          "bad-claim",
          "over-limit",
          "undefined",
          "error",
          "blank-error",
          "timeout-message",
          "long-error",
        ]) {
          workers.modes.set("alpha", mode);
          await get("browser reply " + mode, "/api/browsers/browser/services", {
            status: mode === "trimmed-url" ? 200 : 502,
          });
          const fleet = await get(
            "fleet reply " + mode,
            "/api/projects/folder/browser-services",
            { status: 200 },
          );
          assert.equal(
            fleet.workers[0].status,
            mode === "trimmed-url"
              ? "ok"
              : ["timeout-message", "undefined"].includes(mode)
                ? "timed-out"
                : "error",
          );
          if (mode === "long-error") {
            const message = fleet.workers[0].error.message;
            assert.equal(message.length, 1000);
            assert.equal(message.charCodeAt(999), 0xd83e);
          }
          if (mode === "blank-error")
            assert.equal(fleet.workers[0].error.message, " ");
        }
        workers.modes.clear();
        const partialStart = result.commands.length;
        for (const id of connectedIds) workers.modes.set(id, "hold");
        const concurrent = get(
          "all eligible requests admitted before completion",
          "/api/projects/github/browser-services",
          { status: 200 },
        );
        try {
          await eventually(
            () => result.commands.slice(partialStart),
            (cs) =>
              assert.deepEqual(
                cs.map((c) => c.workerId).sort(),
                [...connectedIds].sort(),
              ),
          );
        } finally {
          workers.release();
        }
        await concurrent;
        workers.modes.clear();
        for (const id of connectedIds) workers.modes.set(id, "bulk");
        const bulk = await get(
          "ordered service budget",
          "/api/projects/github/browser-services",
          { status: 200 },
        );
        assert.equal(bulk.workers.flatMap((w) => w.services).length, 1024);
        assert.equal(bulk.truncated, true);
        const successful = bulk.workers.filter((w) => w.status === "ok");
        assert.deepEqual(
          successful.map((w) => w.services.length),
          [128, 128, 128, 128, 128, 128, 128, 128, 0, 0],
        );
        assert.deepEqual(
          successful.map((w) => w.truncated),
          [false, false, false, false, false, false, false, false, true, true],
        );
        workers.modes.clear();
        workers.modes.set("alpha", "hold");
        await workers.refresh();
        const timedStart = Date.now();
        await Promise.all([
          visit(
            "real 20-second browser deadline",
            "GET",
            "/api/browsers/browser/services",
            { status: 502 },
          ),
          visit(
            "real 20-second fleet deadline",
            "GET",
            "/api/projects/local-git/browser-services",
            { status: 200 },
          ),
        ]);
        result.timeoutElapsedMs = Date.now() - timedStart;
        assert.ok(result.timeoutElapsedMs >= 19500);
        assert.match(
          fixture.records.get("real 20-second browser deadline").error,
          /timed out/u,
        );
        const timed = fixture.records.get("real 20-second fleet deadline");
        assert.equal(timed.partial, true);
        assert.deepEqual(
          timed.workers.map((w) => w.status),
          ["ok", "timed-out"],
        );
        workers.release();
        const start = result.commands.length;
        const disconnected = get(
          "disconnect during command",
          "/api/browsers/browser/services",
          { status: 503 },
        );
        await eventually(
          () => result.commands.length,
          (n) => assert.ok(n > start),
        );
        workers.disconnect("alpha");
        await disconnected;
        workers.release();
        await get("browser disconnected", "/api/browsers/browser/services", {
          status: 503,
        });
        const after = await get(
          "fleet disconnected",
          "/api/projects/local-git/browser-services",
          { status: 200 },
        );
        assert.deepEqual(
          after.workers.map((w) => w.status),
          ["ok", "offline"],
        );
        await live.ping("no discovery mutations");
        assert.deepEqual(
          live.history.filter(
            (e) =>
              e.type === "event" &&
              [
                "browser",
                "tunnel",
                "project-tab-layout",
                "remote-desktop",
                "project-view",
              ].includes(e.resource),
          ),
          [],
        );
        workers.close();
        workers = undefined;
        await live.close();
        live = undefined;
        await fixture.close();
        repo = await openRepo();
        await stored();
        assert.deepEqual(result.stored[1], result.stored[0]);
        await repo.close();
        repo = undefined;
        await fixture.start();
        await get(
          "retained offline after server restart",
          "/api/browsers/browser/services",
          { status: 503 },
        );
      } finally {
        workers?.close();
        await live?.close();
        await repo?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      runtimes[1].observations.toSorted((a, b) => a.name.localeCompare(b.name)),
      runtimes[0].observations.toSorted((a, b) => a.name.localeCompare(b.name)),
      profile + " complete HTTP contract",
    );
    assert.deepEqual(
      runtimes[1].dispatches,
      runtimes[0].dispatches,
      profile + " exact worker selection",
    );
    assert.deepEqual(
      runtimes[1].stored,
      runtimes[0].stored,
      profile + " unchanged durable state",
    );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (failure) report.fixtureRoot = root;
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        observations: r.observations.length,
        timeoutElapsedMs: r.timeoutElapsedMs,
      })),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
