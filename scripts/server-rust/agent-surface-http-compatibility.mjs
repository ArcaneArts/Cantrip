// Actual HTTP/Live/WorkerConnection sockets, with controlled endpoint replies.
// Full-worker/native product acceptance is intentionally recorded separately.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { surfaceWorker, surfaceSeed } from "./agent-surface-http-fixtures.mjs";
import { surfaceContext } from "./agent-surface-http-context.mjs";
import {
  surfaceSuccessCases,
  surfaceClientCases,
} from "./agent-surface-http-success.mjs";
import { surfaceBoundaryCases } from "./agent-surface-http-boundaries.mjs";
import { surfaceTextCases } from "./agent-surface-http-text.mjs";
import { surfacePlacementCases } from "./agent-surface-http-placement.mjs";
import { surfaceRecoveryCases } from "./agent-surface-http-recovery.mjs";
import { surfaceIsolationCases } from "./agent-surface-http-isolation.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-surfaces-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-surfaces-"));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  databaseMode,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, postgres, failure;
try {
  const executable = peers.includes("rust")
    ? (process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")))
    : undefined;
  report.executable = executable;
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
        snapshotProofs: 0,
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
        c.root = root;
        await surfaceSuccessCases(c);
        await surfaceClientCases(c);
        await surfaceBoundaryCases(c);
        await surfaceTextCases(c);
        await surfaceIsolationCases(c);
        await surfaceRecoveryCases(c);
        await surfacePlacementCases(c);
      } catch (error) {
        result.diagnostics = h.diagnostics();
        throw error;
      } finally {
        await h.close();
        h = null;
      }
    }
    if (peers.length === 2) {
      assert.equal(
        p.peers[1].normalizedCalls.length,
        p.peers[0].normalizedCalls.length,
      );
      for (const [index, reference] of p.peers[0].normalizedCalls.entries())
        assert.deepEqual(
          p.peers[1].normalizedCalls[index],
          reference,
          profile + ": " + reference.name,
        );
      assert.deepEqual(
        p.peers[1].disconnections.map((v) => v.comparison),
        p.peers[0].disconnections.map((v) => v.comparison),
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
    pairedCases: report.profiles.reduce(
      (n, p) => n + p.peers[0].calls.length,
      0,
    ),
    report: reportPath,
  }),
);
