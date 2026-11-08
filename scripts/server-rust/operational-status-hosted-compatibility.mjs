// Production entries in hosted configuration with trusted loopback forwarding.
// This exercises proxy-header semantics, not TLS termination or deployment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  systemHealthSchema,
  operationalProbeSchema,
} from "../../packages/protocol/dist/index.js";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { prometheus } from "./operational-status-http-cases.mjs";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(path.join(tmpdir(), "cantrip-operational-hosted-"));
console.error(JSON.stringify({ event: "operational-hosted.created", root }));
const token = "disposable-hosted-operational-metrics-".repeat(3);
const forwarded = {
  "x-forwarded-proto": "https",
  "x-forwarded-host": "api.example.invalid",
};
const report = {
  root,
  completeReplacement: false,
  scope:
    "Actual hosted production entries, external PostgreSQL and trusted loopback forwarding; no TLS termination or deployment claim.",
  runtimes: [],
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustServer({ release: true }));
  report.nativeExecutable = {
    path: executable,
    sha256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  };
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const url = await pg.database();
    const f = new HttpFixture({
      kind,
      executable,
      root,
      name: "hosted",
      databaseMode: "postgres",
      environment: {
        DATABASE_URL: url,
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_REGISTRATION_ENABLED: "true",
        CANTRIP_PUBLIC_REGISTRATION: "true",
        CANTRIP_DEPLOYMENT_MODE: "hosted",
        CANTRIP_BOOTSTRAP_MODE: "hosted",
        CANTRIP_PUBLIC_ORIGIN: "https://api.example.invalid",
        CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
        CANTRIP_TRUSTED_PROXIES: "loopback",
        CANTRIP_METRICS_TOKEN: token,
        CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({
          "fixture-v1": Buffer.alloc(32, 5).toString("base64"),
        }),
      },
    });
    const result = { kind, cases: [], raw: [], exits: [] };
    report.runtimes.push(result);
    let sql, primaryFailure;
    async function request(
      name,
      method,
      route,
      {
        status = 200,
        publicClient = false,
        authorization,
        headers = {},
        forward = true,
      } = {},
    ) {
      const started = Date.now();
      const client = f.client(publicClient ? "public" : "main");
      const response = await fetch(f.server.origin + route, {
        method,
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(forward ? forwarded : {}),
          ...(client.cookies.size
            ? {
                cookie: [...client.cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; "),
              }
            : {}),
          ...(authorization ? { authorization } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      const body =
        text &&
        response.headers.get("content-type")?.startsWith("application/json")
          ? JSON.parse(text)
          : text;
      result.raw.push({
        name,
        method,
        route,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
      });
      assert.equal(response.status, status, name + ": " + text);
      assert.equal(text.includes(token), false);
      assert.equal(
        response.headers.get("strict-transport-security"),
        "max-age=31536000",
      );
      assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
      let proof;
      if (method === "HEAD") {
        assert.equal(text, "");
        proof = "<empty HEAD body>";
      } else if (route === "/api/health" && status === 200) {
        assert.deepEqual(systemHealthSchema.parse(body), body);
        assert.equal(body.database.engine, "postgres");
        assert.equal(body.database.ready, true);
        assert.equal(body.workers.connected, 0);
        proof = {
          status: body.status,
          service: body.service,
          database: body.database,
          workers: body.workers,
          shared: body.operations.coordination.shared,
        };
      } else if (route === "/metrics" && status === 200) {
        const parsed = prometheus(body);
        assert.equal(parsed.number("cantrip_database_ready"), 1);
        const available = parsed.number(
          "cantrip_database_physical_size_available",
        );
        assert.ok(available === 0 || available === 1);
        assert.equal(
          parsed.series.has("cantrip_database_physical_bytes"),
          available === 1,
        );
        assert.equal(
          parsed.series.has(
            "cantrip_account_usage_physical_logical_drift_bytes",
          ),
          available === 1,
        );
        if (available)
          assert.equal(
            BigInt(
              parsed.series.get(
                "cantrip_account_usage_physical_logical_drift_bytes",
              ),
            ),
            BigInt(parsed.series.get("cantrip_database_physical_bytes")) -
              BigInt(
                parsed.series.get(
                  'cantrip_account_usage_logical_bytes{storage_class="server"}',
                ),
              ),
          );
        proof = {
          metadata: parsed.metadata,
          series: [...parsed.series.keys()].filter(
            (key) =>
              ![
                "cantrip_database_physical_bytes",
                "cantrip_account_usage_physical_logical_drift_bytes",
              ].includes(key),
          ),
        };
      } else if (["/healthz", "/readyz"].includes(route) && status === 200) {
        assert.deepEqual(operationalProbeSchema.parse(body), body);
        assert.ok(
          Date.parse(body.timestamp) >= started - 1000 &&
            Date.parse(body.timestamp) <= Date.now() + 1000,
        );
        if (body.database) {
          assert.ok(Number.isFinite(body.database.latencyMs));
          assert.ok(body.database.latencyMs >= 0);
        }
        proof = {
          ...body,
          timestamp: "<validated schema timestamp>",
          ...(body.database
            ? {
                database: { ...body.database, latencyMs: "<measured latency>" },
              }
            : {}),
        };
      } else proof = body;
      result.cases.push({
        name,
        method,
        route,
        status,
        body: proof,
        headers: Object.fromEntries(
          [
            "content-type",
            "cache-control",
            "strict-transport-security",
            "www-authenticate",
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "vary",
          ].map((name) => [name, response.headers.get(name)]),
        ),
      });
      return body;
    }
    try {
      if (kind === "node")
        f.server = await startPackagedNodeServer(
          path.join(repositoryRoot, "cantrip_server"),
          f.environment,
          { nodeExecutable: process.execPath },
        );
      else await f.start();
      const log = path.join(root, kind + ".server.log");
      appendFileSync(log, f.server.diagnostics());
      for (const stream of [f.server.child.stdout, f.server.child.stderr])
        stream.on("data", (bytes) => appendFileSync(log, bytes));
      await request(
        "actual loopback readiness before hosted account requests",
        "GET",
        "/readyz",
        { publicClient: true, forward: false },
      );
      await f.observe(
        "hosted account registration",
        "POST",
        "/api/auth/register",
        {
          status: 201,
          headers: forwarded,
          json: {
            email: "operations@example.invalid",
            displayName: "Operational owner",
            password,
          },
        },
      );
      await f.observe("hosted session", "GET", "/api/auth/session", {
        headers: forwarded,
      });
      sql = postgres(url, { max: 1 });
      await request("hosted owner health", "GET", "/api/health");
      await request("hosted owner metrics", "GET", "/metrics");
      await request(
        "public health remains authenticated despite metrics bearer",
        "GET",
        "/api/health",
        { publicClient: true, authorization: "Bearer " + token, status: 401 },
      );
      await request(
        "public metrics requires authorization",
        "GET",
        "/metrics",
        { publicClient: true, status: 401 },
      );
      await request("public configured bearer", "GET", "/metrics", {
        publicClient: true,
        authorization: "Bearer " + token,
      });
      await request("wrong configured bearer", "GET", "/metrics", {
        publicClient: true,
        authorization: "Bearer " + token + "x",
        status: 401,
      });
      for (const role of ["member", "admin", "owner"]) {
        const changed =
          await sql`UPDATE users SET role=${role} WHERE email='operations@example.invalid'`;
        assert.equal(changed.count, 1);
        await request(
          "hosted account metrics role " + role,
          "GET",
          "/metrics",
          { status: role === "member" ? 401 : 200 },
        );
        await request("hosted health role " + role, "GET", "/api/health");
      }
      for (const [name, headers, status, forward] of [
        [
          "actual HTTP forwarding is rejected",
          { "x-forwarded-proto": "http" },
          400,
          true,
        ],
        [
          "wrong public host is rejected",
          { "x-forwarded-host": "untrusted.invalid" },
          400,
          true,
        ],
        [
          "RFC Forwarded cannot bypass trusted-header policy",
          { forwarded: "for=127.0.0.1;proto=https" },
          400,
          true,
        ],
        [
          "unapproved Origin precedes valid metrics token",
          { origin: "https://untrusted.invalid" },
          403,
          true,
        ],
        ["metrics has no loopback probe exemption", {}, 400, false],
      ])
        await request(name, "GET", "/metrics", {
          publicClient: true,
          authorization: "Bearer " + token,
          headers,
          status,
          forward,
        });
      await request("hosted health HEAD", "HEAD", "/api/health");
      await request("hosted public token metrics HEAD", "HEAD", "/metrics", {
        publicClient: true,
        authorization: "Bearer " + token,
      });
      await request("hosted health preflight", "OPTIONS", "/api/health", {
        publicClient: true,
        headers: { "access-control-request-method": "GET" },
        status: 204,
      });
      await request(
        "direct loopback liveness remains available",
        "GET",
        "/healthz",
        { publicClient: true, forward: false },
      );
      await request(
        "direct loopback readiness remains available",
        "GET",
        "/readyz",
        { publicClient: true, forward: false },
      );
    } catch (error) {
      primaryFailure = error;
      result.failure = { message: error.message, stack: error.stack };
    } finally {
      await sql?.end({ timeout: 0 });
      const server = f.server;
      try {
        await f.close();
      } catch (error) {
        primaryFailure ??= error;
        result.teardownFailure = { message: error.message };
      }
      if (server)
        result.exits.push({
          code: server.child.exitCode,
          signal: server.child.signalCode,
          diagnostics: server.diagnostics(),
        });
    }
    if (primaryFailure) throw primaryFailure;
  }
  assert.deepEqual(report.runtimes[1].cases, report.runtimes[0].cases);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.teardownFailure = { message: error.message };
  }
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    root,
    cases: report.runtimes[0].cases.length,
    exits: report.runtimes.map((r) =>
      r.exits.map((e) => ({ code: e.code, signal: e.signal })),
    ),
  }),
);
