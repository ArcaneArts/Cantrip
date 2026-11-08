// Observe actual Fastify initialization and route registration. The framework's
// diagnostics channel leaves the real production factory and handlers intact.
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fixtureEnvironment } from "./process.mjs";

const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(path.join(tmpdir(), "cantrip-http-log-policy-"));
console.error(JSON.stringify({ root }));
if (process.env.CANTRIP_QA_ROOT)
  appendFileSync(
    path.join(process.env.CANTRIP_QA_ROOT, "source-policy-roots.jsonl"),
    JSON.stringify({ root }) + "\n",
  );
const environment = {
  ...fixtureEnvironment(root),
  CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
};
for (const key of Object.keys(process.env))
  if (key.startsWith("CANTRIP_") || ["DATABASE_URL", "REDIS_URL"].includes(key))
    delete process.env[key];
Object.assign(process.env, environment);

const routes = new Map();
let factories = 0;
function observe(app) {
  factories++;
  app.addHook("onRoute", (options) => {
    for (const method of Array.isArray(options.method)
      ? options.method
      : [options.method]) {
      const row = {
        method,
        path: options.url,
        level: options.logLevel ?? "info",
      };
      const key = method + " " + row.path;
      if (routes.has(key)) assert.deepEqual(routes.get(key), row);
      routes.set(key, row);
    }
  });
  return app;
}
const initialization = channel("fastify.initialization");
const initialized = ({ fastify }) => observe(fastify);
initialization.subscribe(initialized);
let database, app, failure;
const report = { root, completeReplacement: false };
try {
  const { readServerConfig } =
    await import("../../cantrip_server/src/config.ts");
  const { connectDatabase } =
    await import("../../cantrip_server/src/db/index.ts");
  const { buildApp } = await import("../../cantrip_server/src/app.ts");
  const config = readServerConfig();
  database = await connectDatabase(config);
  app = await buildApp({ config, database, logger: false });
  await app.ready();
  assert.equal(factories, 1, "Observe the actual production Fastify factory");
  report.routes = [...routes.values()].sort((a, b) =>
    (a.method + " " + a.path).localeCompare(b.method + " " + b.path, "en"),
  );
  assert.ok(
    report.routes.length > 500,
    "All actual app/plugin registrations are observed",
  );
  const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  );
  const Router = createRequire(require.resolve("fastify"))("find-my-way");
  let targetError = null;
  const router = Router({
    onBadUrl: (path) => {
      targetError = { code: "FST_ERR_BAD_URL", path };
    },
    onMaxParamLength: (path) => {
      targetError = { code: "FST_ERR_MAX_PARAM_LENGTH", path };
    },
  });
  for (const route of report.routes)
    router.on(route.method, route.path, () => {}, route);
  const probes = new Map();
  const probe = (method, target) => {
    targetError = null;
    const match = router.find(method, target);
    if (match?.store === null) match.handler();
    probes.set(method + " " + target, {
      method,
      target,
      matched: match?.store ?? null,
      params: match?.store ? match.params : null,
      error: targetError,
    });
  };
  for (const route of report.routes) {
    for (const parameter of [
      "",
      "value",
      "a%2Fb",
      "a+b",
      "%E2%98%83",
      "%FF",
      "%GG",
      "x".repeat(100),
      "x".repeat(101),
      "%78".repeat(50),
      "%F0%9F%98%80".repeat(50),
      "%F0%9F%98%80".repeat(51),
      "%252F",
    ])
      probe(
        route.method,
        route.path === "*"
          ? "/policy-wildcard"
          : route.path.replace(/:[^/]+/g, parameter),
      );
    const canonical = route.path.replace(/:[^/]+/g, "value");
    for (const method of new Set([
      route.method,
      "GET",
      "HEAD",
      "POST",
      "OPTIONS",
      "QUERY",
    ]))
      for (const target of [
        canonical,
        canonical + "/",
        canonical + "?token=private-policy-query",
        canonical.toUpperCase(),
        canonical.replace("/api/", "/%61pi/"),
      ])
        probe(method, target);
  }
  for (const method of ["GET", "HEAD", "OPTIONS", "POST"])
    for (const target of [
      "/",
      "*",
      "/api/policy-missing",
      "/api/workers/value/version/extra",
      "http://127.0.0.1/%61pi/workers",
      "http://127.0.0.1/api/workers/%GG/version?private=value",
    ])
      probe(method, target);
  report.probes = [...probes.values()];
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  initialization.unsubscribe(initialized);
  if (app) await app.close();
  else await database?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    root,
    factories,
    routes: report.routes.length,
    levels: [...new Set(report.routes.map((r) => r.level))],
  }),
);
