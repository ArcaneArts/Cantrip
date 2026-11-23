import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { createRequire } from "node:module";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import {
  customizationHttpWorker,
  customizationMarker,
} from "./chat-customization-http-worker.mjs";
import { runChatCustomizationHttpCases } from "./chat-customization-http-cases.mjs";
import { runChatConfigurationHttpCases } from "./chat-configuration-http-cases.mjs";
import { runStandaloneCustomizationHttpCases } from "./chat-customization-http-standalone.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const production = process.argv.includes("--production");
const databaseMode =
    option("--database") ?? (production ? "postgres" : "pglite"),
  root = await mkdtemp(path.join(tmpdir(), "cantrip-customization-http-"));
const report = {
  suite: "chat-customization-and-configuration-http",
  databaseMode,
  root,
  completeReplacement: false,
  productionRuntime: production,
  usesSqlHttpFixture: !production,
  profiles: [],
  cleanupFailures: [],
};
let pg, h, controller, failure, databaseClient;
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");
try {
  const executable =
      (production
        ? process.env.CANTRIP_RUST_SERVER_BINARY
        : process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY) ??
      (production
        ? await buildRustServer()
        : await buildRustExample("http-sql-fixture")),
    repositoryExecutable =
      process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
      (await buildRustExample("project-repository-fixture")),
    passwordHash = await hashPassword(password);
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
        commands: [],
        runtimeCalls: [],
        permissionWrites: [],
        cryptoProofs: 0,
        snapshotProofs: 0,
        recovery: [],
        durable: [],
      };
      outputs.push(result);
      controller = customizationHttpWorker(result, () => h);
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: !production,
        environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "2" },
        url: databaseUrl,
        configure: (owner) => [
          ...inventorySeed(owner, { kind: "openai-compatible", worker }),
          ...inventorySeed(owner, {
            id: "customization-other-provider",
            kind: "openai-compatible",
            worker,
          }),
          "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
          `UPDATE chats SET automation_paused=true,model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
        ],
        onCommand: controller.onCommand,
      });
      try {
        if (production) {
          databaseClient = postgres(databaseUrl, { max: 2, prepare: false });
          h.fixture.sql = async (statements = [], queries = []) =>
            databaseClient.begin(async (tx) => {
              for (const statement of statements) await tx.unsafe(statement);
              const results = [];
              for (const query of queries) {
                const rows = await tx.unsafe(query);
                results.push(rows[0] ? JSON.parse(rows[0].result) : null);
              }
              return results;
            });
          result.sqlRouteAbsent = await h.fixture.observe(
            "SQL test route absent",
            "POST",
            "/__fixture/sql",
            { csrf: true, json: { statements: [], queries: [] }, status: 404 },
          );
        }
        if (!process.argv.includes("--configuration-only"))
          await runChatCustomizationHttpCases({
            h,
            result,
            profile,
            controller,
          });
        if (!process.argv.includes("--configuration-only"))
          await runStandaloneCustomizationHttpCases({
            h,
            result,
            profile,
            controller,
          });
        if (!process.argv.includes("--customizations-only"))
          await runChatConfigurationHttpCases({
            h,
            result,
            profile,
            controller,
          });
        await h.live.subscribed("customization-final-barrier", [
          { kind: "chat", chatId: chat },
        ]);
        result.events = h.live.history
          .filter(
            (e) =>
              e.type === "event" &&
              ["customization", "chat", "chat-plan"].includes(e.resource),
          )
          .map(({ scope, resource, action, entityId, revision, payload }) =>
            h.fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
          );
        if (!process.argv.includes("--customizations-only")) {
          const planEvents = result.events.filter(
            (e) => e.resource === "chat-plan",
          );
          assert.ok(
            planEvents.length > 0,
            "Actual Plan writes publish Live invalidations",
          );
          for (const event of planEvents) {
            assert.deepEqual(event.scope, { kind: "chat", chatId: chat });
            assert.equal(event.action, "invalidated");
            assert.equal(event.payload, null);
          }
        }
        result.observations = controller.canonical(result.observations);
        for (const value of [
          ...h.fixture.records.values(),
          h.live.history,
          h.diagnostics(),
        ])
          assert.equal(
            JSON.stringify(value).includes(customizationMarker),
            false,
            "private customization content never reaches server plaintext",
          );
      } finally {
        result.diagnostics = h.diagnostics();
        controller.release();
        const server = h.fixture.server;
        await h.close();
        h = null;
        result.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
        assert.deepEqual(result.exit, { code: 0, signal: null });
        await databaseClient?.end({ timeout: 5 });
        databaseClient = null;
      }
    }
    for (const key of [
      "observations",
      "commands",
      "runtimeCalls",
      "permissionWrites",
      "cryptoProofs",
      "snapshotProofs",
      "events",
      "recovery",
      "durable",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
} finally {
  controller?.release();
  try {
    await h?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailures.push(error.stack ?? String(error));
  }
  try {
    await databaseClient?.end({ timeout: 5 });
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailures.push(error.stack ?? String(error));
  }
  if (failure) report.passed = false;
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/chat-customizations-http-${databaseMode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      databaseMode,
      profiles: report.profiles.length,
      passed: report.passed ?? false,
      report: destination,
    }),
  );
}
if (failure) throw failure;
