// Run independent MCP clients against the extracted native Server and Worker packages.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { productionClient } from "../server-rust/production-server-process.mjs";
import {
  authorizeWorker,
  connectStdio,
  eventually,
  packagedServerArguments,
  protection,
  stageFixtureCodegraph,
} from "./external-mcp-acceptance-fixture.mjs";
import { verifyExecution } from "./external-mcp-execution-cases.mjs";
import { verifyInspection } from "./external-mcp-inspection-cases.mjs";
import { verifyOrchestration } from "./external-mcp-orchestration-cases.mjs";

const { values } = parseArgs({
  options: {
    "server-package": { type: "string" },
    "worker-package": { type: "string" },
    "codegraph-distribution": { type: "string" },
    carrier: { type: "string", default: "relay" },
    browser: { type: "boolean" },
  },
});
assert.ok(
  values["server-package"] && values["worker-package"],
  "Pass --server-package and --worker-package with the extracted package directories.",
);

const codegraph = values["codegraph-distribution"];
const suffix = process.platform === "win32" ? ".exe" : "";
const serverPackage = path.resolve(values["server-package"]);
const workerPackage = path.resolve(values["worker-package"]);
const server = path.join(serverPackage, "bin", "cantrip-server" + suffix);
const worker = path.join(workerPackage, "bin", "cantrip-worker" + suffix);
const codex = path.join(workerPackage, "bin", "codex" + suffix);

await verifyLocal();
await run("external-mcp-grants-smoke.mjs", [
  "--server",
  server,
  "--server-package",
  serverPackage,
  "--worker",
  worker,
  "--codex",
  codex,
  "--bundled-codex",
  "--https",
  "--carrier",
  values.carrier,
  ...(codegraph ? ["--codegraph-distribution", path.resolve(codegraph)] : []),
  ...(values.browser ? ["--browser"] : []),
]);

console.log(
  JSON.stringify({
    result: "passed",
    platform: process.platform,
    architecture: process.arch,
    packagedServer: true,
    packagedWorker: true,
    packagedCodex: true,
    local: "stdio",
    hosted: ["stdio", "https"],
    hostedCarrier: values.carrier,
    codegraph: Boolean(codegraph),
  }),
);

async function run(file, args) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL(file, import.meta.url)), ...args],
    { stdio: "inherit", windowsHide: true },
  );
  const [code] = await once(child, "close");
  assert.equal(code, 0, file + " failed");
}

async function verifyLocal() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-mcp-package-local-"),
  );
  const workerDirectory = path.join(directory, "worker");
  const workerId = randomUUID();
  const projectId = randomUUID();
  let core, client, stopWorker;
  let diagnostics = "";

  try {
    const codegraphHome = await stageFixtureCodegraph({
      distribution: codegraph,
      directory,
      workerDirectory,
    });
    const environment = {
      ...fixtureEnvironment(path.join(directory, "server")),
      CANTRIP_BOOTSTRAP_MODE: "standalone",
      CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
      CANTRIP_WORKER_LINK_LOCAL_ENABLED: "true",
    };
    delete environment.CANTRIP_WORKER_TOKEN;
    core = await startServer(
      server,
      [
        "--port",
        "0",
        "--external-mcp-local-port",
        "0",
        "--shutdown-on-stdin-close",
        ...(await packagedServerArguments(serverPackage)),
      ],
      { cwd: directory, env: environment },
    );
    const origin = core.events.find(
      ({ event }) => event === "server.external-mcp.listening",
    )?.origin;
    assert.ok(origin);
    const account = productionClient(core);
    const ownerVisit = (method, route, status, json) =>
      account.visit("packaged local MCP", method, route, { status, json });

    const enroll = await ownerVisit(
      "POST",
      "/api/workers/enrollment-codes",
      201,
      {
        label: "Packaged local MCP worker",
      },
    );
    const startWorker = async (code) => {
      const child = spawn(worker, ["--shutdown-on-stdin-close"], {
        cwd: directory,
        env: {
          ...environment,
          CANTRIP_WORKER_DATA_DIR: workerDirectory,
          CANTRIP_SERVER_URL: core.origin,
          CANTRIP_WORKER_ID: workerId,
          CANTRIP_EXTERNAL_MCP_FIXTURE_SECRET: "temporary fixture marker",
          ...(code ? { CANTRIP_WORKER_ENROLLMENT_CODE: code } : {}),
          ...(codegraphHome ? { HOME: codegraphHome } : {}),
        },
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const completion = once(child, "close");
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-12_000);
      });
      stopWorker = async () => {
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          assert.deepEqual(await completion, [0, null], diagnostics);
        } finally {
          clearTimeout(timer);
          stopWorker = undefined;
        }
      };
      await eventually(() =>
        ownerVisit("GET", "/api/workers/" + workerId + "/version", 200),
      );
    };
    await startWorker(enroll.code);
    await authorizeWorker({
      ownerVisit,
      workerId,
      ownerId: "00000000-0000-0000-0000-000000000001",
      workload: true,
    });
    await ownerVisit("POST", "/api/projects/from-folder", 202, {
      id: projectId,
      workerId,
      nameProtection: protection,
    });
    await eventually(async () => {
      const job = await ownerVisit(
        "GET",
        "/api/projects/" + projectId + "/folder-setup",
        200,
      );
      assert.equal(job.state, "succeeded", JSON.stringify(job.error));
    });
    const connect = (suppressOperation, onSuppressed) =>
      connectStdio({
        binary: worker,
        origin,
        directory,
        suppressOperation,
        onSuppressed,
      });
    client = await connect();
    const discover = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent;
    };
    assert.ok(
      (await discover("project_list", {})).entries.some(
        ({ id }) => id === projectId,
      ),
    );
    const first = await discover("worker_context", { projectId });
    assert.equal(first.workerId, workerId);
    assert.equal(first.transport, "local");
    await verifyOrchestration({
      client,
      projectId,
      ownerVisit,
      eventually,
      connect,
      actorLabel: "Local MCP client",
    });
    await verifyInspection({
      client,
      directory,
      workerDirectory,
      projectId,
      ownerVisit,
      codegraphInstalled: Boolean(codegraphHome),
      scoped: false,
    });
    const verifyInterrupted = await verifyExecution({
      client,
      directory,
      workerDirectory,
      projectId,
      ownerVisit,
      eventually,
    });
    await stopWorker();
    await startWorker();
    assert.notEqual(
      (await discover("worker_context", { projectId })).processGeneration,
      first.processGeneration,
    );
    await verifyInterrupted(client);
    console.log(
      JSON.stringify({
        suite: "packaged-local-external-mcp",
        carrier: "local",
        passed: true,
      }),
    );
  } catch (error) {
    if (diagnostics) console.error(diagnostics);
    throw error;
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await stopWorker?.();
      } finally {
        await core?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
