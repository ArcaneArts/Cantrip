// Actual production-router HTTP/worker transport. The controlled endpoint opens
// requests and seals replies; it does not execute Git or external GitHub writes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsWorker as worker,
  settingsProject as project,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { repositoryCommandFixtures } from "./repository-command-fixtures.mjs";
import { repositoryCommandRelay } from "./repository-command-relay.mjs";
import { repositoryCommandDashboard } from "./repository-command-dashboard.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-repository-command-http-"),
);
const report = {
  suite: "repository-command-public-http",
  databaseMode,
  root,
  completeReplacement: false,
  actualGitExecution: false,
  profiles: [],
};
const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const projectPath = `/api/projects/${project}/worktrees/${tree}/repository-operation`;
const workerPath = `/api/workers/${worker}/repository-operation`;
let pg, active, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const fixtures = await repositoryCommandFixtures(),
    passwordHash = await hashPassword(password);
  report.innerTypes = fixtures.cases.map((s) => s.type);
  report.legacyRoutes = fixtures.legacyRoutes;
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        rawCommands: [],
        dashboardCommands: [],
        rawDashboardCommands: [],
        plaintextCommands: [],
        cryptoProofs: 0,
        snapshotProofs: 0,
        endpointProofs: [],
        serverExits: [],
      };
      outputs.push(result);
      const relay = repositoryCommandRelay(result);
      const dashboard = repositoryCommandDashboard(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        url,
        passwordHash,
        result,
        liveSqlFixture: true,
        onCommand: async (...args) =>
          (await dashboard.onCommand(...args)) ?? relay.onCommand(...args),
      }));
      try {
        let ordinal = 800;
        const invoke = async (
          name,
          endpoint,
          input,
          status = 200,
          extra = {},
        ) => h.visit(name, "POST", endpoint, { json: input, status, ...extra });
        for (const sample of fixtures.cases)
          for (const workerScope of [false, true]) {
            const body = await relay.prepare(
              h,
              sample,
              id(ordinal++),
              workerScope,
            );
            const response = await invoke(
              (workerScope ? "worker " : "project ") + sample.type,
              workerScope ? workerPath : projectPath,
              body,
            );
            assert.equal(response.operationId, body.operationId);
            await relay.proveResponse(h, response);
          }
        const before = result.rawCommands.length;
        for (const route of fixtures.legacyRoutes) {
          const endpoint = route.path
            .replace(/:([A-Za-z0-9_]+)/g, (_, name) =>
              name === "projectId"
                ? project
                : name === "worktreeId"
                  ? tree
                  : name === "workerId"
                    ? worker
                    : id(999),
            )
            .replaceAll("*", "fixture");
          const response = await h.visit(
            "retired " + route.method + " " + route.path,
            route.method,
            endpoint,
            {
              status: 410,
              ...(!["GET", "HEAD"].includes(route.method)
                ? { json: { privateLegacyInput: "must-not-dispatch" } }
                : {}),
            },
          );
          if (route.method !== "HEAD")
            assert.equal(
              response.error,
              "This plaintext repository route was removed. Use the protected repository operation endpoint.",
            );
        }
        assert.equal(
          result.rawCommands.length,
          before,
          "retired plaintext endpoints dispatch no work",
        );
        const sample = fixtures.cases.find((s) => s.type === "git.status");
        const original = await relay.prepare(h, sample, id(ordinal++), false);
        await invoke(
          "strict protected wrapper rejects unknown fields",
          projectPath,
          { ...original, plaintext: "forbidden" },
          400,
        );
        if (profile === "accounts") {
          await invoke(
            "foreign owner cannot dispatch project repository request",
            projectPath,
            original,
            404,
            { client: "other" },
          );
          await invoke(
            "foreign owner cannot dispatch worker repository request",
            workerPath,
            { ...original, scopeId: "worker-repository-scope" },
            404,
            { client: "other" },
          );
        }
        assert.equal(result.rawCommands.length, before);
        await dashboard.run(h);
        const previous = h.worker.connectionGeneration();
        h.worker.close();
        await h.reconnectWorker();
        assert.notEqual(h.worker.connectionGeneration(), previous);
        await relay.proveResponse(
          h,
          await invoke(
            "encrypted repository request after worker replacement",
            projectPath,
            original,
          ),
        );
        const process = h.fixture.server,
          port = Number(new URL(process.origin).port);
        await h.live.close();
        h.worker.close();
        await h.fixture.close();
        result.serverExits.push(process.diagnostics());
        await h.fixture.start({ port });
        await h.reconnectWorker();
        assert.equal(
          (
            await h.visit(
              "repository server identity after restart",
              "GET",
              "/api/bootstrap",
            )
          ).server.id,
          h.serverId,
        );
        await relay.proveResponse(
          h,
          await invoke(
            "original encrypted request after server restart",
            projectPath,
            original,
          ),
        );
        assert.equal(result.rawCommands.length, fixtures.cases.length * 2 + 2);
        relay.finish(h);
      } catch (error) {
        result.error = { message: error.message, diagnostics: h.diagnostics() };
        throw error;
      } finally {
        await h.close();
        active = null;
      }
    }
    for (const key of [
      "observations",
      "commands",
      "plaintextCommands",
      "dashboardCommands",
      "cryptoProofs",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
    innerTypes: report.innerTypes.length,
    legacyRoutes: report.legacyRoutes.length,
  }),
);
