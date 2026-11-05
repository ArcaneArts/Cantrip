// Actual HTTP rejection boundaries; no claim of successful Task dispatch.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskInferenceInputDispatchSchema } from "../../packages/protocol/dist/index.js";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
  settingsTree,
} from "./native-settings-http-fixture.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath =
  option("--report") ?? `.qa/rust-server/task-input-http-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-input-http-"));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  databaseMode,
  actualHttp: true,
  successfulTaskDispatch: false,
  completeReplacement: false,
  profiles: [],
};
let active, postgres, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const peers = [];
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], calls: [] };
      peers.push(result);
      const url =
        postgres && (kind === "node" || databaseMode === "postgres")
          ? await postgres.database()
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
      }));
      const input = taskInferenceInputDispatchSchema.parse({
        serverId: h.serverId,
        workerId: settingsWorker,
        workerGeneration: h.worker.connectionGeneration(),
        receipt: {
          operationId: "00000000-0000-4000-8000-000000000011",
          chatId: settingsChat,
          clientMessageId: "missing-task-message",
          workerId: settingsWorker,
          worktreeId: settingsTree,
          executionLaneId: "00000000-0000-4000-8000-000000000014",
          executionLaneActivatedAt: "2026-11-05T00:00:00.000Z",
          providerId: "missing-task-provider",
          modelRouteId: "missing-task-model",
          providerAccountId: null,
          dispatch: {
            cycleId: "00000000-0000-4000-8000-000000000012",
            operationId: "00000000-0000-4000-8000-000000000013",
            leaseOwner: "missing-task-lease",
            fencingToken: 1,
          },
        },
      });
      async function call(
        name,
        body,
        status,
        code,
        { route = "task-input-dispatch", token = h.credential } = {},
      ) {
        const value = await h.visit(
          name,
          "POST",
          "/api/internal/native-commands/" + route,
          {
            client: "worker",
            headers: { authorization: "Bearer " + token },
            json: body,
            status,
          },
        );
        assert.deepEqual(value, { code }, `${kind} ${name}`);
        result.calls.push({ name, status, body: value });
      }
      await call(
        "invalid body before authentication",
        {},
        400,
        "invalid-task-input-dispatch",
        { token: "invalid" },
      );
      await call(
        "invalid receipt",
        { ...input, receipt: {} },
        400,
        "invalid-task-input-dispatch",
      );
      await call(
        "invalid phase",
        { ...input, phase: "other" },
        400,
        "invalid-task-input-dispatch",
      );
      await call(
        "invalid recovery body before authentication",
        {},
        400,
        "invalid-inference-recovery",
        { route: "inference-recovery", token: "invalid" },
      );
      await call("invalid worker credential", input, 401, "unauthorized", {
        token: "invalid",
      });
      await call(
        "credential cannot select another worker",
        { ...input, workerId: "other-worker" },
        401,
        "unauthorized",
      );
      await call(
        "stale server identity",
        { ...input, serverId: "other-server" },
        409,
        "stale-worker-generation",
      );
      await call(
        "stale process generation",
        { ...input, workerGeneration: randomUUID() },
        409,
        "stale-worker-generation",
      );
      await call(
        "current worker missing canonical round",
        input,
        409,
        "stale-task-input",
      );
      await call(
        "accepted phase missing canonical round",
        { ...input, phase: "accepted" },
        409,
        "stale-task-input",
      );
      await h.close();
      active = undefined;
    }
    assert.deepEqual(peers[0].calls, peers[1].calls, profile);
  }
  report.compatibilityPassed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await active?.close();
  await postgres?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
