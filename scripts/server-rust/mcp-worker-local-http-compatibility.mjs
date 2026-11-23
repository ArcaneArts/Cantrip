// Actual server HTTP + production worker broker/MCP HTTP + WorkerWebService.
// Search/fetch/browser boundaries are controlled; no full worker/native claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANTRIP_MCP_OPERATIONS } from "../../packages/protocol/dist/index.js";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { surfaceWorker, surfaceSeed } from "./agent-surface-http-fixtures.mjs";
import { surfaceContext } from "./agent-surface-http-context.mjs";
import { workerLocalBrokerCases } from "./mcp-worker-local-broker.mjs";
import { workerLocalHttpCases } from "./mcp-worker-local-http-cases.mjs";
import { privateWebText } from "./mcp-worker-local-fixtures.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-worker-local-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-worker-local-"));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  databaseMode,
  actualHttp: true,
  actualWorkerConnection: true,
  actualMcpHttp: true,
  actualWorkerWebService: true,
  controlledSearchFetchBrowserBoundaries: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, postgres, failure;
// Verify every opaque reference and generated timestamp before normalization.
function normalizeBroker(value, aliases = new Map(), key) {
  if (typeof value === "string") {
    if (/^(?:wsr|wrc|wss)_[A-Za-z0-9_-]{32}$/u.test(value)) {
      if (!aliases.has(value))
        aliases.set(value, `<${value.slice(0, 3)}:${aliases.size}>`);
      return aliases.get(value);
    }
    if (key === "retrievedAt") {
      assert.ok(Math.abs(Date.parse(value) - Date.now()) < 300000);
      return "<verified worker clock>";
    }
    return value.replace(/wss_[A-Za-z0-9_-]{32}/gu, (id) =>
      normalizeBroker(id, aliases),
    );
  }
  if (Array.isArray(value))
    return value.map((v) => normalizeBroker(v, aliases, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        normalizeBroker(v, aliases, k),
      ]),
    );
  return value;
}
const audits = async (fixture) =>
  (
    await fixture.sql(
      [],
      [
        "SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text AS result FROM audit_events a WHERE a.action LIKE 'mcp.%'",
      ],
    )
  )[0];
try {
  const executable = peers.includes("rust")
    ? (process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")))
    : undefined;
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of peers) {
      const result = {
        kind,
        observations: [],
        commands: [],
        calls: [],
        normalizedCalls: [],
      };
      p.peers.push(result);
      const state = surfaceWorker();
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          postgres && (kind === "node" || databaseMode === "postgres")
            ? await postgres.database()
            : undefined,
        onCommand: state.onCommand,
      });
      try {
        await h.fixture.sql(surfaceSeed(h.owner));
        const c = await surfaceContext(h, state, result);
        c.binding.allowedOperations = [...CANTRIP_MCP_OPERATIONS];
        const before = await audits(h.fixture),
          commandCount = state.commands.length;
        await workerLocalBrokerCases(h, c.binding, root, result);
        assert.deepEqual(
          await audits(h.fixture),
          before,
          "worker-local tools never reach server operation execution/audit",
        );
        assert.equal(state.commands.length, commandCount);
        const diagnostics = h.diagnostics();
        for (const secret of [
          privateWebText.trim(),
          "Worker-private search query",
          "Worker-private typed text",
          "Worker-private accessibility tree",
        ])
          assert.ok(
            !diagnostics.includes(secret),
            "worker-local plaintext stays out of server diagnostics",
          );
        result.normalizedBrokers = normalizeBroker(result.brokers);
        await workerLocalHttpCases(c);
      } catch (error) {
        result.diagnostics = h.diagnostics();
        throw error;
      } finally {
        await h.close();
        h = null;
      }
    }
    if (peers.length === 2) {
      assert.deepEqual(
        p.peers[1].normalizedBrokers,
        p.peers[0].normalizedBrokers,
        profile + " actual MCP tool catalogs/results/routing",
      );
      assert.deepEqual(
        p.peers[1].normalizedCalls,
        p.peers[0].normalizedCalls,
        profile + " direct HTTP scope/errors/audit",
      );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (h) await h.close();
  await postgres?.close();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
    pairedHttpCases: report.profiles.reduce(
      (n, p) => n + p.peers[0].calls.length,
      0,
    ),
    report: reportPath,
  }),
);
