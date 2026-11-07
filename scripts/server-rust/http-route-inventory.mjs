// Discovery audit through real production HTTP. Missing-resource and invalid
// input observations detect missing routes; they do not prove domain parity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";

const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(path.join(tmpdir(), "cantrip-rust-http-inventory-"));
const rawInventory = await readFile(
  path.join(repositoryRoot, "docs/security/server-route-inventory.json"),
);
const inventory = JSON.parse(rawInventory);
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ??
  (await buildRustServer({ release: true }));
const report = {
  root,
  completeReplacement: false,
  inventorySha256: createHash("sha256").update(rawInventory).digest("hex"),
  rustExecutableSha256: createHash("sha256")
    .update(await readFile(executable))
    .digest("hex"),
  scope:
    "All declared methods/paths through current production servers on isolated PGlite profiles with local authentication, absent resource identities and empty JSON bodies. Non-upgrade requests inspect WebSocket routes. Only generic Rust fallback differences are classified; this does not prove successful operations or overall response parity.",
  responses: [],
  exits: [],
};
const identity = "99999999-9999-4999-8999-999999999999";
let server, failure;
try {
  for (const kind of ["node", "rust"]) {
    const directory = path.join(root, kind);
    await mkdir(directory);
    const environment = {
      ...fixtureEnvironment(directory),
      CANTRIP_AUTH_RATE_LIMIT: "1000",
      CANTRIP_API_RATE_LIMIT_PER_MINUTE: "10000",
    };
    server =
      kind === "node"
        ? await startPackagedNodeServer(
            path.join(repositoryRoot, "cantrip_server"),
            environment,
            { nodeExecutable: process.execPath },
          )
        : await startServer(
            executable,
            [
              "--port",
              "0",
              "--data-dir",
              directory,
              "--database",
              "pglite",
              "--shutdown-on-stdin-close",
            ],
            { cwd: repositoryRoot, env: environment },
          );
    const log = path.join(directory, "server.log");
    appendFileSync(log, server.diagnostics());
    for (const stream of [server.child.stdout, server.child.stderr])
      stream.on("data", (chunk) => appendFileSync(log, chunk));
    const rows = [];
    report.responses.push({ kind, rows });
    for (const route of inventory.routes) {
      const url = route.path.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, identity);
      const write = !["GET", "HEAD"].includes(route.method);
      try {
        const response = await fetch(server.origin + url, {
          method: route.method,
          headers: {
            origin: "http://127.0.0.1:5173",
            ...(write ? { "content-type": "application/json" } : {}),
          },
          ...(write ? { body: "{}" } : {}),
          signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        rows.push({
          method: route.method,
          path: route.path,
          url,
          status: response.status,
          body,
          contentType: response.headers.get("content-type"),
        });
      } catch (error) {
        rows.push({
          method: route.method,
          path: route.path,
          url,
          error: error.message,
        });
      }
    }
    await server.close();
    report.exits.push({
      kind,
      code: server.child.exitCode,
      signal: server.child.signalCode,
    });
    server = undefined;
  }
  assert.equal(report.responses[0].rows.length, inventory.routes.length);
  assert.equal(report.responses[1].rows.length, inventory.routes.length);
  report.rustFallbacks = report.responses[1].rows.flatMap((rust, index) => {
    const node = report.responses[0].rows[index];
    return rust.status === 404 &&
      rust.body?.error === "Not Found" &&
      rust.body?.message?.startsWith("Route ") &&
      JSON.stringify(rust.body) !== JSON.stringify(node.body)
      ? [{ method: rust.method, path: rust.path, node, rust }]
      : [];
  });
  assert.ok(
    report.responses.every((runtime) =>
      runtime.rows.every((row) => !row.error),
    ),
    "Every HTTP request must complete; errors are retained in the report",
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (server) await server.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      root,
      routesPerPeer: inventory.routes.length,
      rustFallbacks: report.rustFallbacks?.length,
      exits: report.exits,
      failed: Boolean(failure),
    }),
  );
}
if (failure) throw failure;
if (report.rustFallbacks.length) process.exitCode = 1;
