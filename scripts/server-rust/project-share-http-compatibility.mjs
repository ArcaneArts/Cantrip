// Full route/worker/Live comparison with real databases and actual SQL failures.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { AttachmentFixture } from "./tunnel-attachment-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
} from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { shareStateSql, standaloneSql } from "./project-share-http-state.mjs";
import { shareHttpCases, input } from "./project-share-http-cases.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-share-http-"));
const report = {
  suite: "actual-protected-project-share-http",
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
      const fixture = new AttachmentFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
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
        changes: [],
        stored: [],
      };
      runtimes.push(result);
      let repo, live;
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const liveEvents = () =>
        live.history
          .filter((e) => e.type === "event" && e.resource === "tunnel")
          .map(({ resource, scope, entityId, revision, payload, action }) => ({
            resource,
            scope,
            entityId,
            revision,
            payload,
            action,
          }));
      const livePing = (name) => live.ping(name);
      const visit = async (name, method, url, options = {}) => {
        const before = live ? liveEvents().length : 0,
          commandStart = result.commands.length;
        const observed = await fixture.observe(name, method, url, {
          timeoutMs: 45000,
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...observed });
        const value = fixture.records.get(name);
        if (value?.workerRequestId) {
          const request = result.commands
            .slice(commandStart)
            .filter((c) => c.command.type === "project.share.open")
            .at(-1);
          assert.ok(
            request,
            "Failure corresponds to an actual observed worker request",
          );
          assert.equal(value.workerRequestId, request.requestId);
        }
        if (live && !options.deferEvents) {
          await livePing(name);
          const changes = liveEvents().slice(before);
          result.changes.push({ name, events: changes });
          assert.equal(
            changes.length,
            options.events ?? 0,
            name + " exact Live event count",
          );
        }
        return value;
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              json: {
                email: `share-${client}@example.invalid`,
                displayName: client,
                password,
              },
              status: 201,
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of [...targetStateSql(owner, other), ...shareStateSql()])
          await repo.seed(sql);
        const transaction = await repo.request({
          op: "transaction",
          statements: standaloneSql(owner),
        });
        assert.equal(transaction.rejected, false, transaction.diagnostic);
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("project shares", [
          currentUser,
          { kind: "project", projectId: "github" },
        ]);
        await shareHttpCases({
          fixture,
          root: path.join(root, profile, kind, "worker"),
          profile,
          result,
          visit,
          liveEvents,
          livePing,
        });
        await live.close();
        live = undefined;
        await fixture.close();
        repo = await openRepo();
        const state = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('tunnels',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tunnels t),'attachments',(SELECT jsonb_agg(jsonb_build_object('status',status,'errorCode',error_code,'secretHashPresent',secret_hash IS NOT NULL) ORDER BY id) FROM tunnel_attachments)) result",
        });
        assert.equal(state.rejected, false, state.diagnostic);
        result.stored.push(fixture.normalize(state.value));
        await repo.close();
        repo = undefined;
        await fixture.start();
        await visit(
          "offline after restart",
          "POST",
          "/api/projects/github/network-shares",
          { json: input(), status: 503 },
        );
      } finally {
        await live?.close();
        await repo?.close();
        await fixture.close();
      }
      result.normalizedCommands = result.commands.map(({ workerId, command }) =>
        fixture.normalize({ workerId, command }),
      );
    }
    assert.deepEqual(
      runtimes[1].observations.toSorted((a, b) => a.name.localeCompare(b.name)),
      runtimes[0].observations.toSorted((a, b) => a.name.localeCompare(b.name)),
      profile + " HTTP contract",
    );
    assert.deepEqual(
      runtimes[1].normalizedCommands,
      runtimes[0].normalizedCommands,
      profile + " exact opaque worker requests",
    );
    assert.deepEqual(
      runtimes[1].changes.toSorted((a, b) => a.name.localeCompare(b.name)),
      runtimes[0].changes.toSorted((a, b) => a.name.localeCompare(b.name)),
      profile + " exact Live scopes and order",
    );
    assert.deepEqual(
      runtimes[1].stored,
      runtimes[0].stored,
      profile + " actual durable state",
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
        commands: r.commands.length,
      })),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
