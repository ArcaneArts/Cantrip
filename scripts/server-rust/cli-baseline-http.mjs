// Observe the existing worker CLI client against both real server peers before
// registering the new native transport. Keep the raw result, including failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import {
  settingsHttpFixture,
  settingsWorker,
} from "./native-settings-http-fixture.mjs";
import { invokeCantripCliCommand } from "../../cantrip_worker/src/cli-client.ts";

const root = await mkdtemp(path.join(tmpdir(), "cantrip-cli-baseline-"));
const reportPath = ".qa/rust-server/cli-before-http-v1.json";
const report = {
  root,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  databaseMode: "pglite",
  profile: "none",
  actualWorkerClient: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  peers: [],
};
let h, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  for (const kind of ["node", "rust"]) {
    const result = { kind, observations: [], commands: [] };
    report.peers.push(result);
    h = await settingsHttpFixture({
      kind,
      profile: "none",
      root,
      executable,
      databaseMode: "pglite",
      liveSqlFixture: true,
      result,
    });
    try {
      const request = {
        command: "status",
        context: {
          codexThreadId: null,
          terminalId: null,
          cwd: null,
          selection: "auto",
        },
        arguments: {},
      };
      try {
        result.client = {
          ok: await invokeCantripCliCommand({
            request,
            requestId: "existing-worker-cli-status",
            serverUrl: h.fixture.server.origin,
            token: h.credential,
            workerId: settingsWorker,
          }),
        };
      } catch (error) {
        result.client = {
          error: {
            name: error.name,
            status: error.status,
            code: error.code,
            message: error.message,
          },
        };
      }
      const response = await fetch(
        new URL("/api/internal/cli", h.fixture.server.origin),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${h.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...request,
            context: { cwd: null, terminalId: null, codexThreadId: null },
            workerId: settingsWorker,
            requestId: "raw-cli-status",
            chatContext: null,
          }),
        },
      );
      result.raw = {
        status: response.status,
        body: await response.text(),
        headers: Object.fromEntries(response.headers),
      };
      result.diagnostics = h.diagnostics();
      if (kind === "node") {
        assert.equal(response.status, 200, result.raw.body);
        assert.equal(result.client.ok?.data.context, null);
      }
    } finally {
      await h.close();
      h = null;
    }
  }
  report.recorded = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (h) await h.close();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    recorded: true,
    peers: report.peers.map((p) => ({
      kind: p.kind,
      status: p.raw?.status,
      clientSucceeded: Boolean(p.client?.ok),
    })),
    report: reportPath,
  }),
);
