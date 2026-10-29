// Real production HTTP, authorization, response validation and Live hooks.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  label,
} from "./project-target-state.mjs";
import {
  tunnelStateSql,
  tunnelIds,
  tunnelExpiry,
  tunnelRecord,
  secretExpiry,
} from "./tunnel-state.mjs";
import { password } from "./security-fixtures.mjs";
import { tunnelHttpCases, httpTunnelIds } from "./tunnel-http-cases.mjs";
const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-tunnel-http-"));
const report = {
  suite: "actual-tunnel-catalog-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
class Fixture extends HttpFixture {
  normalize(value, key = "") {
    if (key === "expiresAt" && value === tunnelExpiry) return value;
    if (key.endsWith("_at") && typeof value === "string") {
      const date = new Date(value).toISOString();
      if (
        (key === "expires_at" && date === tunnelExpiry) ||
        (key === "secret_expires_at" && date === secretExpiry)
      )
        return date;
      return super.normalize(date, key.slice(0, -3) + "At");
    }
    return super.normalize(value, key);
  }
}
const events = (live) =>
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
      const fixture = new Fixture({
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
        changes: [],
        raw: [],
        rawStates: [],
      };
      runtimes.push(result);
      let repo, live, foreignLive;
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const openLive = async () => {
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("tunnel-catalog", [
          currentUser,
          { kind: "project", projectId: "github" },
        ]);
        if (profile === "accounts") {
          foreignLive = await new LiveProbe(fixture, {
            client: "other",
          }).open();
          await foreignLive.initialized();
          await foreignLive.subscribed();
        }
      };
      const closeLive = async () => {
        if (live || foreignLive)
          (result.liveSegments ??= []).push({
            main: live?.history,
            other: foreignLive?.history,
          });
        await foreignLive?.close();
        foreignLive = undefined;
        await live?.close();
        live = undefined;
      };
      const visit = async (label, method, url, options = {}) => {
        const before = live ? events(live).length : 0,
          foreignBefore = foreignLive ? events(foreignLive).length : 0;
        const observation = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...observation });
        const raw = fixture.records.get(label);
        result.raw.push({ label, body: raw });
        if (live) {
          const success =
            !["GET", "HEAD"].includes(method) && observation.status < 400;
          if (success) {
            const end = Date.now() + 15000;
            while (events(live).length === before) {
              assert.ok(
                Date.now() < end,
                label + " response-completion invalidation",
              );
              await delay(10);
            }
          }
          const nonce = "tunnel-check-" + result.observations.length;
          await live.ping(nonce);
          const actual = events(live).slice(before);
          const entity =
            method === "POST"
              ? null
              : decodeURIComponent(url.split("/").at(-1));
          const expected = success
            ? [
                {
                  resource: "tunnel",
                  scope: currentUser,
                  entityId: entity,
                  revision: null,
                  payload: null,
                  action: "invalidated",
                },
              ]
            : [];
          assert.deepEqual(
            actual,
            expected,
            label + " exact Live invalidations",
          );
          if (foreignLive) {
            await foreignLive.ping(nonce);
            assert.equal(
              events(foreignLive).length,
              foreignBefore,
              label + " tenant isolation",
            );
          }
          result.changes.push({ label, events: actual });
        }
        return raw;
      };
      const state = async (label) => {
        repo = await openRepo();
        const value = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('tunnels',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tunnels t),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tunnel_attachments a),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY capability_id) FROM tunnel_attachment_direct_leases l)) result",
        });
        assert.equal(value.rejected, false);
        result.rawStates.push({ label, value: value.value });
        await repo.close();
        repo = undefined;
        return fixture.normalize(value.value);
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
                email: "tunnel-" + client + "@example.invalid",
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
          ...tunnelStateSql(owner, other),
        ])
          await repo.seed(sql);
        for (const [index, id] of Object.values(httpTunnelIds)
          .slice(2)
          .entries()) {
          await repo.seed(
            "INSERT INTO tunnels SELECT (jsonb_populate_record(NULL::tunnels,to_jsonb(t)||jsonb_build_object('id'," +
              literal(id) +
              ",'position'," +
              (index + 10) +
              "))).* FROM tunnels t WHERE id=" +
              literal(tunnelIds.main),
          );
        }
        await repo.seed(
          "UPDATE tunnels SET protected_content=" +
            json({ opaque: "invalid-wire-only" }) +
            " WHERE id=" +
            literal(httpTunnelIds.invalidRecord),
        );
        await repo.seed(
          "CREATE FUNCTION http_tunnel_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private fixture tunnel failure'; END $$",
        );
        for (const [verb, id, condition] of [
          ["INSERT", httpTunnelIds.insertError, "NEW.id="],
          [
            "UPDATE",
            httpTunnelIds.updateError,
            "NEW.protected_revision>OLD.protected_revision AND NEW.id=",
          ],
          ["DELETE", httpTunnelIds.deleteError, "OLD.id="],
        ])
          await repo.seed(
            "CREATE TRIGGER http_tunnel_" +
              verb.toLowerCase() +
              " BEFORE " +
              verb +
              " ON tunnels FOR EACH ROW WHEN (" +
              condition +
              literal(id) +
              ") EXECUTE FUNCTION http_tunnel_failure()",
          );
        await repo.close();
        repo = undefined;
        await fixture.start();
        await openLive();
        // The invalid stored record makes only its own reads and owner catalog
        // fail response validation. Repair it before exercising ordinary lists.
        await visit(
          "invalid catalog response validation",
          "GET",
          "/api/tunnels",
          { status: 500 },
        );
        await visit(
          "invalid stored opaque record maps to 500",
          "GET",
          "/api/tunnels/" + httpTunnelIds.invalidRecord,
          { status: 500 },
        );
        await visit(
          "repair initial invalid record",
          "PATCH",
          "/api/tunnels/" + httpTunnelIds.invalidRecord,
          {
            json: {
              protectedRecord: {
                ...tunnelRecord,
                operationId: httpTunnelIds.invalidRecord,
                revision: 2,
              },
            },
          },
        );
        await visit(
          "delete repaired record",
          "DELETE",
          "/api/tunnels/" + httpTunnelIds.invalidRecord,
          { status: 204 },
        );
        await tunnelHttpCases({ visit, profile });
        await closeLive();
        await fixture.close();
        result.state = await state("after HTTP mutations");
        await fixture.start();
        await visit(
          "accepted create survives server restart",
          "GET",
          "/api/tunnels/" + httpTunnelIds.created,
        );
        await fixture.close();
        repo = await openRepo();
        // listProjects runs before the requested project existence check.
        await repo.seed(
          "UPDATE projects SET protected_label=" +
            json({ invalid: true }) +
            " WHERE id='folder'",
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        await visit(
          "project listing validation precedes missing project",
          "GET",
          "/api/projects/missing/tunnels",
          { status: 500 },
        );
        await visit(
          "global tunnel catalog does not list projects",
          "GET",
          "/api/tunnels",
        );
        await fixture.close();
        repo = await openRepo();
        await repo.seed(
          "UPDATE projects SET protected_label=" +
            json(label("project")) +
            " WHERE id='folder'",
        );
        await repo.close();
        repo = undefined;
      } finally {
        await closeLive();
        await repo?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      {
        observations: runtimes[1].observations,
        changes: runtimes[1].changes,
        state: runtimes[1].state,
      },
      {
        observations: runtimes[0].observations,
        changes: runtimes[0].changes,
        state: runtimes[0].state,
      },
      profile + " exact Source/Rust HTTP, Live and persisted state",
    );
  }
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      "Tunnel HTTP cleanup failed",
    );
  }
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
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
        changes: r.changes.length,
      })),
    })),
    error: report.error?.message,
  }),
);
if (failure) throw failure;
