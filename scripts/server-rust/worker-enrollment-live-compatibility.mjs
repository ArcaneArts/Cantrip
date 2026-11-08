// Real HTTP and App Live comparison of enrollment/credential response effects.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-enrollment-live-"),
);
console.error(JSON.stringify({ root }));
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const peers = [];
    let reference;
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const result = { kind, http: [], publications: [] };
      peers.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        root,
        name: profile,
        databaseMode: values.database,
        executable,
        auditObservations: true,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      if (kind === "node") reference = f;
      else f.auditReference = reference;
      let live, server;
      const visit = async (name, method, url, options = {}) => {
        result.http.push({
          name,
          ...(await f.observe(name, method, url, { csrf: true, ...options })),
        });
        return f.records.get(name);
      };
      const mutate = async (name, method, url, options, entity) => {
        await live.ping(name + " before");
        const offset = live.frames.length;
        const response = await visit(name, method, url, options);
        await live.ping(name + " after");
        const events = live.frames
          .slice(offset)
          .filter(
            (frame) => frame.type === "event" && frame.resource === "worker",
          )
          .map(({ cursor, ...frame }) => f.normalize(frame));
        result.publications.push({ name, events });
        assert.deepEqual(
          events,
          entity === undefined
            ? []
            : [
                {
                  type: "event",
                  scope: { kind: "current-user" },
                  resource: "worker",
                  action: "invalidated",
                  entityId: entity,
                  revision: null,
                  payload: null,
                  occurredAt: "<timestamp>",
                },
              ],
          kind +
            "/" +
            name +
            " publishes exactly the reference response-completion invalidation",
        );
        return response;
      };
      try {
        await f.start();
        server = f.server;
        if (profile === "accounts")
          await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "enrollment-live@example.invalid",
              displayName: "Enrollment",
              password,
            },
          });
        else if (profile === "password")
          await visit("login", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        live = new LiveProbe(f);
        await live.open();
        await live.initialized();
        await live.subscribed();
        await mutate(
          "invalid enrollment",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 400, json: { expiresInSeconds: 0 } },
        );
        const code = await mutate(
          "create enrollment",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Live worker" } },
          null,
        );
        await mutate(
          "read enrollment",
          "GET",
          "/api/workers/enrollment-codes/" + code.id,
          {},
        );
        await visit("enroll", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          status: 201,
          json: {
            code: code.code,
            heartbeat: { ...heartbeat, workerId: "live-worker" },
          },
        });
        await live.ping("enrollment presence settled");
        await mutate(
          "missing worker rotation",
          "POST",
          "/api/workers/missing/credentials/rotate",
          { status: 404, json: {} },
        );
        await mutate(
          "invalid rotation",
          "POST",
          "/api/workers/live-worker/credentials/rotate",
          { status: 400, json: { label: 17 } },
        );
        const rotated = await mutate(
          "rotate credential",
          "POST",
          "/api/workers/live-worker/credentials/rotate",
          { json: { label: "Rotated worker" } },
          "live-worker",
        );
        assert.equal(rotated.delivered, false);
        await mutate(
          "read credentials",
          "GET",
          "/api/workers/live-worker/credentials",
          {},
        );
        await mutate(
          "revoke credential",
          "DELETE",
          "/api/workers/live-worker/credentials/" +
            rotated.credentialSummary.id,
          { status: 204 },
          "live-worker",
        );
        await mutate(
          "missing credential",
          "DELETE",
          "/api/workers/live-worker/credentials/11111111-1111-4111-8111-111111111111",
          { status: 404 },
        );
        result.passed = true;
      } finally {
        result.liveHistory = live?.history;
        result.diagnostics = server?.diagnostics();
        await live?.close();
        await f.close();
        result.exit = {
          code: server?.child.exitCode,
          signal: server?.child.signalCode,
        };
      }
    }
    assert.deepEqual(peers[1].http, peers[0].http, "HTTP contracts");
    assert.deepEqual(
      peers[1].publications,
      peers[0].publications,
      "Response-completion App Live publications",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(
      path.resolve(values.report),
      JSON.stringify(report, null, 2) + "\n",
    );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: report.passed,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      peers: p.peers.map((r) => ({
        kind: r.kind,
        http: r.http.length,
        publications: r.publications.length,
        exit: r.exit,
      })),
    })),
  }),
);
