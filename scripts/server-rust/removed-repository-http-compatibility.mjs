// Actual production routers, HTTP parsing/authentication and isolated databases.
// No retired plaintext worker handler is restored or substituted by the fixture.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { removedRepositoryContract } from "./removed-repository-contract.mjs";
import { eventually } from "./full-worker.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-removed-repository-"));
const report = {
  root,
  database: values.database,
  completeReplacement: false,
  scope:
    "Retired repository HTTP contracts, parsing/authentication/rate-limit precedence and negative routing controls; this is not successful active-domain or platform qualification.",
  profiles: [],
};
const password = "isolated retired repository password";
const id = "99999999-9999-4999-8999-999999999999";
const url = (route) => route.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, id);
const contract = await removedRepositoryContract();
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const message = (route) =>
  route.gitAgent
    ? "This plaintext Git agent route was removed. Use the protected repository operation endpoint."
    : "This plaintext repository route was removed. Use the protected repository operation endpoint.";
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustServer({ release: true }));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const modes = [
    "none",
    "password",
    "accounts",
    ...(values.database === "postgres" ? ["hosted-accounts"] : []),
  ].filter((mode) => !values.profile || mode === values.profile);
  assert.ok(modes.length, "Known profile for the selected database");
  for (const mode of modes) {
    const hosted = mode === "hosted-accounts";
    const authMode = hosted ? "accounts" : mode;
    const forwarded = hosted
      ? {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.invalid",
        }
      : {};
    const profile = { mode, runtimes: [] };
    report.profiles.push(profile);
    for (const kind of ["node", "rust"].filter(
      (kind) => !values.runtime || kind === values.runtime,
    )) {
      const databaseUrl =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        executable,
        root,
        name: mode,
        databaseMode: values.database,
        environment: {
          CANTRIP_AUTH_MODE: authMode,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_API_BODY_LIMIT_BYTES: "16384",
          CANTRIP_API_RATE_LIMIT_PER_MINUTE: "120",
          ...(hosted
            ? {
                CANTRIP_DEPLOYMENT_MODE: "hosted",
                CANTRIP_BOOTSTRAP_MODE: "hosted",
                CANTRIP_PUBLIC_ORIGIN: "https://api.example.invalid",
                CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
                CANTRIP_TRUSTED_PROXIES: "loopback",
                CANTRIP_PUBLIC_REGISTRATION: "true",
                CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({
                  "fixture-v1": Buffer.alloc(32, 5).toString("base64"),
                }),
              }
            : {}),
          ...(mode === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, observations: [] };
      profile.runtimes.push(result);
      const visit = async (label, method, target, options = {}) => {
        const observed = await f.observe(label, method, target, {
          csrf: true,
          ...options,
          headers: { ...forwarded, ...options.headers },
        });
        result.observations.push({ label, ...observed });
        return observed;
      };
      try {
        if (kind === "node")
          f.server = await startPackagedNodeServer(
            path.join(repositoryRoot, "tests/reference-node-server"),
            f.environment,
            { nodeExecutable: process.execPath },
          );
        else await f.start();
        await mkdir(path.join(root, mode, kind), { recursive: true });
        const log = path.join(root, mode, kind, "server.log");
        appendFileSync(log, f.server.diagnostics());
        for (const stream of [f.server.child.stdout, f.server.child.stderr])
          stream.on("data", (chunk) => appendFileSync(log, chunk));
        const readiness = await fetch(f.server.origin + "/readyz");
        assert.equal(readiness.status, 200);
        result.database = (await readiness.json()).database;
        assert.equal(
          result.database.engine,
          values.database === "pglite" ? "pglite" : "postgres",
        );
        if (authMode === "accounts")
          await f.observe("register", "POST", "/api/auth/register", {
            status: 201,
            headers: forwarded,
            json: {
              displayName: "Retired routes",
              email: "retired@example.invalid",
              password,
            },
          });
        if (mode === "password")
          await f.observe("login", "POST", "/api/auth/login", {
            json: { password },
          });
        await f.observe("session", "GET", "/api/auth/session", {
          headers: forwarded,
        });
        let agentBudgetStart, agentBudgetEnd;
        for (const [i, route] of contract.entries()) {
          if (route.gitAgent) agentBudgetStart = Date.now();
          const observed = await visit(
            "retired " + i,
            route.method,
            url(route.path),
            {
              status: 410,
              ...(!["GET", "HEAD"].includes(route.method) ? { json: {} } : {}),
            },
          );
          if (route.gitAgent) agentBudgetEnd = Date.now();
          assert.deepEqual(observed.body, { error: message(route) });
          if (route.method === "GET")
            await visit("retired HEAD " + i, "HEAD", url(route.path), {
              status: 410,
              compareContentLength: true,
            });
          if (route.method !== "GET" && !route.gitAgent)
            await visit(
              "malformed retired " + i,
              route.method,
              url(route.path),
              { status: 410, json: {}, raw: "{" },
            );
        }
        const agent = contract.find((route) => route.gitAgent);
        const generic = contract.find(
          (route) =>
            route.method === "POST" &&
            route.path.includes("/projects/") &&
            !route.gitAgent,
        );
        for (const route of [
          generic,
          contract.find(
            (route) =>
              route.method === "POST" && route.path.startsWith("/api/github/"),
          ),
        ]) {
          await visit("oversized " + route.path, "POST", url(route.path), {
            status: 410,
            json: {},
            raw: JSON.stringify({ private: "x".repeat(32768) }),
          });
          await visit(
            "unsupported media " + route.path,
            "POST",
            url(route.path),
            {
              status: 410,
              json: {},
              headers: { "content-type": "application/x-retired-fixture" },
            },
          );
        }
        // The separate Git-agent tombstone runs as an ordinary handler: its
        // registered parser and request budget still take precedence.
        await visit("Git-agent malformed JSON", "POST", url(agent.path), {
          status: 400,
          json: {},
          raw: "{",
        });
        await visit("Git-agent oversized JSON", "POST", url(agent.path), {
          status: 413,
          json: {},
          raw: JSON.stringify({ private: "x".repeat(32768) }),
        });
        await visit("Git-agent unsupported media", "POST", url(agent.path), {
          status: 415,
          json: {},
          headers: { "content-type": "application/x-retired-fixture" },
        });
        const paths = [...new Set(contract.map((route) => route.path))];
        for (const [i, target] of paths.entries())
          await visit("unsupported method " + i, "PUT", url(target), {
            status: target.startsWith("/api/github/") ? 410 : 404,
            json: {},
          });
        for (const target of [
          `/api/projects/${id}/git/not-a-registered-operation`,
          `/api/projects/${id}/worktrees/${id}/git/commits/not-a-real-operation/unknown`,
          `/api/projects/${id}/worktrees/${id}/github/not-a-registered-operation`,
        ])
          await visit("unknown " + target, "POST", target, {
            status: 404,
            json: {},
          });
        await visit(
          "unknown GitHub catalog prefix",
          "PUT",
          "/api/github/not-a-registered-operation",
          { status: 410, json: {}, raw: "{" },
        );
        if (mode !== "none") {
          await visit(
            "authentication precedes retirement",
            "POST",
            url(generic.path),
            {
              status: 401,
              client: "anonymous",
              csrf: false,
              json: {},
              raw: "{",
            },
          );
          await visit("CSRF precedes retirement", "POST", url(generic.path), {
            status: 403,
            csrf: false,
            json: {},
            raw: "{",
          });
        }
        await visit("origin precedes retirement", "POST", url(generic.path), {
          status: 403,
          json: {},
          headers: { origin: "http://rejected.invalid" },
        });
        const auditLabels = [
          ["retired " + contract.indexOf(generic), id],
          ["malformed retired " + contract.indexOf(generic), id],
          ["unsupported method " + paths.indexOf(generic.path), null],
          [
            "unknown /api/projects/" + id + "/git/not-a-registered-operation",
            null,
          ],
        ];
        const audit = await eventually(
          async () => {
            await f.observe(
              "audit observation",
              "GET",
              "/api/account/audit-events?limit=200",
              { headers: forwarded },
            );
            return f.records.get("audit observation");
          },
          (data) => {
            for (const [label] of auditLabels) {
              const request = [...f.requests].find(
                ([, value]) => value === label,
              )?.[0];
              assert.ok(request, label);
              const event = data.items.find(
                (event) => event.requestId === request,
              );
              assert.ok(event, label);
            }
          },
        );
        result.audit = auditLabels.map(([label, resourceId]) => {
          const request = [...f.requests].find(
            ([, value]) => value === label,
          )[0];
          const event = audit.items.find(
            (event) => event.requestId === request,
          );
          assert.equal(event.resource.id, resourceId, label);
          assert.equal(event.result, "failed");
          return {
            label,
            action: event.action,
            result: event.result,
            resourceType: event.resource.type,
            resourceId: event.resource.id,
          };
        });
        // Local deployments disable general API limits. Hosted limits are
        // scoped to owner/method/registered route, not the whole account.
        if (hosted) {
          for (let attempt = 0; attempt <= 120; attempt++)
            await visit(
              "guard bypasses hosted budget " + attempt,
              "POST",
              url(generic.path),
              { status: 410, json: {}, raw: "{" },
            );
          const cookies = [...f.client().cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
          const statuses = [];
          for (let attempt = 0; attempt <= 120; attempt++) {
            const started = Date.now();
            const response = await fetch(f.server.origin + url(agent.path), {
              method: "POST",
              headers: {
                ...forwarded,
                origin: "http://127.0.0.1:5173",
                cookie: cookies,
                "x-cantrip-csrf": f.client().csrf,
                "content-type": "application/json",
              },
              body: "{}",
              signal: AbortSignal.timeout(15000),
            });
            const body = await response.json();
            const completed = Date.now();
            statuses.push(response.status);
            assert.ok(
              [410, 429].includes(response.status),
              JSON.stringify(body),
            );
            if (response.status === 429) {
              const retry = body.retryAfterSeconds;
              assert.equal(response.headers.get("retry-after"), String(retry));
              assert.ok(
                retry >=
                  Math.max(
                    1,
                    Math.ceil((agentBudgetStart + 60000 - completed) / 1000),
                  ) &&
                  retry <=
                    Math.max(
                      1,
                      Math.ceil((agentBudgetEnd + 60000 - started) / 1000),
                    ),
                "Retry interval belongs to the actual first request's sliding window",
              );
              assert.deepEqual(body, {
                code: "api-rate-limited",
                error: `Cantrip server request limit reached for this operation. Retry after ${retry} ${retry === 1 ? "second" : "seconds"}.`,
                retryAfterSeconds: retry,
              });
              result.rateRejection = {
                body,
                retryAfter: response.headers.get("retry-after"),
                firstRequest: [agentBudgetStart, agentBudgetEnd],
                rejectedRequest: [started, completed],
              };
              break;
            }
            assert.deepEqual(body, { error: message(agent) });
          }
          assert.equal(statuses.at(-1), 429);
          result.rateBudget = statuses;
          await visit(
            "other route retains independent budget",
            "GET",
            "/api/projects",
          );
          await visit(
            "guard still rejects after agent budget exhaustion",
            "POST",
            url(generic.path),
            { status: 410, json: {}, raw: "{" },
          );
          await visit(
            "GitHub retirement after agent budget exhaustion",
            "PUT",
            "/api/github/unknown-after-limit",
            { status: 410, json: {}, raw: "{" },
          );
        }
      } finally {
        const server = f.server;
        await f.close();
        result.exit = server
          ? { code: server.child.exitCode, signal: server.child.signalCode }
          : null;
        if (server) assert.deepEqual(result.exit, { code: 0, signal: null });
      }
    }
    if (!values.runtime) {
      assert.deepEqual(
        profile.runtimes[1].observations,
        profile.runtimes[0].observations,
      );
      assert.deepEqual(
        profile.runtimes[1].rateBudget,
        profile.runtimes[0].rateBudget,
      );
      assert.deepEqual(profile.runtimes[1].audit, profile.runtimes[0].audit);
    }
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      root,
      profiles: report.profiles.length,
      routes: contract.length,
      observations: report.profiles
        .flatMap((p) => p.runtimes)
        .map((r) => r.observations.length),
      failed: Boolean(failure),
    }),
  );
}
if (failure) throw failure;
