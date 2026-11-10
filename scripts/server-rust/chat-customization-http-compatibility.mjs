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
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-customization-http-"));
const report = {
  suite: "chat-customization-and-configuration-http",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
  cleanupFailures: [],
};
let pg, h, controller, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
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
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "2" },
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
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
        await h.close();
        h = null;
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
