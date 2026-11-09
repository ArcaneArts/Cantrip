// Real production executables and public enrollment routes; no SQL fixture,
// injected command bus or inference substitute is installed in either server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { workerHeartbeatSchema } from "../../packages/protocol/dist/index.js";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-model-operation-boundary-"),
);
const report = {
  root,
  database: values.database,
  completeReplacement: false,
  scope:
    "HTTP validation, owner isolation, configuration failures and unavailable-worker cancellation; successful inference and endpoint decryption require separate product acceptance.",
  profiles: [],
};
const password = "isolated current model operation password";
const operationId = "11111111-1111-4111-8111-111111111111";
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustServer({ release: true }));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  let runtime;
  if (values.database === "pglite") {
    runtime = path.join(root, "native-pglite-runtime");
    await promisify(execFile)(executable, [
      "--materialize-pglite-runtime",
      runtime,
    ]);
  }
  for (const mode of ["none", "password", "accounts"].filter(
    (mode) => !values.profile || mode === values.profile,
  )) {
    const profile = { mode, runtimes: [] };
    report.profiles.push(profile);
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        root,
        name: mode,
        databaseMode: values.database,
        executable,
        environment: {
          CANTRIP_AUTH_MODE: mode,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(mode === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(runtime ? { PGLITE_RUNTIME_DIR: runtime } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const output = { kind, observations: [] };
      profile.runtimes.push(output);
      const visit = async (label, target, options = {}, method = "POST") => {
        output.observations.push({
          label,
          ...(await f.observe(label, method, target, {
            csrf: true,
            ...options,
          })),
        });
        return f.records.get(label);
      };
      try {
        if (kind === "node")
          f.server = await startPackagedNodeServer(
            path.join(repositoryRoot, "tests/reference-node-server"),
            f.environment,
            { nodeExecutable: process.execPath },
          );
        else await f.start();
        output.pid = f.server.child.pid;
        const readiness = await fetch(f.server.origin + "/readyz");
        assert.equal(readiness.status, 200);
        output.database = (await readiness.json()).database;
        assert.equal(output.database.status, "ready");
        assert.equal(
          output.database.engine,
          values.database === "pglite" ? "pglite" : "postgres",
        );
        const logs = path.join(root, mode, kind, "server.log");
        await mkdir(path.dirname(logs), { recursive: true });
        appendFileSync(logs, f.server.diagnostics());
        for (const stream of [f.server.child.stdout, f.server.child.stderr])
          stream.on("data", (chunk) => appendFileSync(logs, chunk));
        if (mode === "accounts") {
          for (const client of ["main", "other"]) {
            await f.observe(
              "register " + client,
              "POST",
              "/api/auth/register",
              {
                client,
                status: 201,
                json: {
                  displayName: "Model boundary " + client,
                  email: client + "@model-boundary.invalid",
                  password,
                },
              },
            );
            await f.observe("session " + client, "GET", "/api/auth/session", {
              client,
            });
          }
        } else {
          if (mode === "password")
            await f.observe("login", "POST", "/api/auth/login", {
              json: { password },
            });
          await f.observe("session", "GET", "/api/auth/session");
        }
        const code = await f.observe(
          "enrollment",
          "POST",
          "/api/workers/enrollment-codes",
          {
            csrf: true,
            status: 201,
            json: { label: "Offline model boundary" },
          },
        );
        await f.observe(
          "enroll offline worker",
          "POST",
          "/api/internal/workers/enroll",
          {
            client: "worker",
            status: 201,
            json: {
              code: f.records.get("enrollment").code,
              heartbeat: workerHeartbeatSchema.parse({
                workerId: "model-boundary-worker",
                name: "Offline boundary worker",
                platform: process.platform,
                architecture: process.arch,
                codexVersion: null,
                startedAt: "2026-10-25T00:00:00.000Z",
              }),
            },
          },
        );
        assert.equal(code.status, 201);
        for (const operation of ["embedding", "decision"])
          for (const cancel of [false, true]) {
            const target = `/api/model-operations/${operation}${cancel ? "/cancel" : ""}`;
            const valid = {
              operationId,
              scope: { workerId: "model-boundary-worker", modelId: null },
              ...(!cancel
                ? {
                    protectedRequest: {
                      ...policyEnvelope,
                      domain: "model-operation-content",
                    },
                  }
                : {}),
            };
            for (const [label, json] of [
              ["missing", {}],
              ["null", null],
              ["array", []],
              ["unknown field", { ...valid, privateUnexpected: "must reject" }],
              ["invalid id", { ...valid, operationId: "invalid" }],
              [
                "unknown scope",
                { ...valid, scope: { ...valid.scope, extra: true } },
              ],
            ])
              await visit(target + "/" + label, target, { status: 400, json });
            await visit(target + "/missing worker", target, {
              status: 404,
              json: {
                ...valid,
                scope: { ...valid.scope, workerId: "missing-worker" },
              },
            });
            if (mode === "accounts")
              await visit(target + "/foreign worker", target, {
                client: "other",
                status: 404,
                json: valid,
              });
            if (mode !== "none") {
              await visit(target + "/anonymous", target, {
                client: "anonymous",
                status: 401,
                json: valid,
              });
              await visit(target + "/csrf", target, {
                csrf: false,
                status: 403,
                json: valid,
              });
            }
            await visit(target + "/owned offline worker", target, {
              status: cancel ? 502 : 409,
              json: valid,
            });
            if (!cancel)
              await visit(target + "/unconfigured model", target, {
                status: 409,
                json: {
                  ...valid,
                  scope: { ...valid.scope, modelId: "unconfigured-model" },
                },
              });
          }
      } finally {
        await f.close();
        output.closed = true;
      }
    }
    assert.deepEqual(
      profile.runtimes[1].observations,
      profile.runtimes[0].observations,
      `${mode}: exact Node/Rust HTTP contracts`,
    );
    profile.pass = true;
  }
  assert.ok(report.profiles.length, "At least one requested auth profile ran");
} catch (error) {
  failure = error;
  report.error = error.stack ?? String(error);
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupError = String(error);
  }
  report.pass = !failure;
  const destination = values.report ?? path.join(root, "report.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(
    JSON.stringify({ root, report: destination, pass: report.pass }) + "\n",
  );
}
if (failure) throw failure;
