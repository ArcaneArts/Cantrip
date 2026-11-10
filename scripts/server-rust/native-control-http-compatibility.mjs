// Production HTTP/Live/WorkerConnection sockets and actual SQL. Native replies
// are controlled; this suite does not replace full-worker product acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import {
  nativeControlContexts,
  seedStandaloneControl,
  nativeControlQuery,
} from "./native-control-http-state.mjs";
import { nativeControlHttpCases } from "./native-control-http-cases.mjs";
import { nativeControlQueueCases } from "./native-control-queue-cases.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-control-http-"));
const report = {
  suite: "native-control-http",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
let pg, h, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_REPOSITORY_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        rawCommands: [],
        durable: [],
        rawDurable: [],
        disconnections: [],
        replacements: [],
        rawReplacements: [],
        deadlines: [],
        rawDeadlines: [],
        snapshotProofs: 0,
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const controls = {
        mode: "normal",
        interrupted: true,
        held: null,
        hold() {
          this.mode = "hold";
          let release;
          const promise = new Promise((resolve) => (release = resolve));
          this.held = { requested: false, released: false, promise, release };
          return this.held;
        },
      };
      let queue;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        databaseMode,
        url,
        passwordHash,
        result,
        liveSqlFixture: true,
        executable,
        repositoryExecutable,
        configure: (owner) => [
          ...inventorySeed(owner, { kind: "openai-compatible", worker }),
          "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
          "UPDATE chats SET automation_paused=true",
          ...seedStandaloneControl(owner),
        ],
        onCommand: async (command) => {
          result.rawCommands.push(structuredClone(command));
          if (command.type === "chat.queue.changed") return null;
          if (command.type === "chat.queue.prepare")
            return queue.prepare(command);
          if (
            ![
              "chat.interrupt",
              "chat.native-control",
              "chat.native-logical.cancel",
            ].includes(command.type)
          )
            return undefined;
          const p = nativeControlContexts.find(
            (p) => p.chat === command.chatId,
          );
          assert.ok(p, "known command Chat authority");
          if (command.type === "chat.interrupt")
            assert.deepEqual(command, {
              type: "chat.interrupt",
              executionProfile: p.profile,
              chatId: p.chat,
              threadId: p.thread,
            });
          else if (command.type === "chat.native-control")
            assert.deepEqual(command, {
              type: "chat.native-control",
              chatId: p.chat,
              threadId: p.thread,
              nativeActivationGeneration: p.activation,
              nativeRuntimeGeneration: p.nativeRuntime,
              modelRouteId: null,
              providerAccountId: null,
              control: { kind: "interrupt" },
            });
          else
            assert.deepEqual(command, {
              type: "chat.native-logical.cancel",
              chatId: p.chat,
              rootOperationId: p.operation,
              rootOperationGeneration: p.generation,
            });
          result.commands.push(h.fixture.normalize(command));
          if (command.type !== "chat.native-logical.cancel")
            return { interrupted: controls.interrupted };
          if (controls.mode === "notification-error")
            throw new Error(
              "controlled native cancellation notification failure",
            );
          if (controls.mode === "hold") {
            const held = controls.held;
            held.requested = true;
            await held.promise;
            held.released = true;
          }
          return null;
        },
      });
      let retained;
      try {
        await h.live.subscribed(
          "native-control-contexts",
          nativeControlContexts.map((p) => ({ kind: "chat", chatId: p.chat })),
        );
        await nativeControlHttpCases({ h, result, profile, controls });
        queue = nativeControlQueueCases(h, result);
        await queue.run(profile);
        await h.live.ping("native-control-final-effects");
        queue.finish();
        result.observations = queue.canonical(result.observations);
        result.commands = queue.canonical(result.commands);
        retained = await h.fixture.sql(
          [],
          nativeControlContexts.map((p) =>
            nativeControlQuery(p, true).replace(" result", "::text result"),
          ),
        );
        result.rawRetained = retained;
      } finally {
        controls.held?.release();
        result.diagnostics = h.diagnostics();
        await h.close();
        h = null;
      }
      const reopened = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        result.rawReopened = [];
        for (const p of nativeControlContexts) {
          const value = await reopened.request({
            op: "query-json",
            sql: nativeControlQuery(p, true),
          });
          assert.equal(value.rejected, false, value.diagnostic);
          result.rawReopened.push(value.value);
        }
        assert.deepEqual(
          result.rawReopened,
          retained,
          "all retained Chat, command, activation and lane columns reopen exactly",
        );
        result.exactReopens = retained.length;
      } finally {
        await reopened.close();
      }
      console.log(
        JSON.stringify({
          phase: "peer-complete",
          databaseMode,
          profile,
          kind,
          http: result.observations.length,
          commands: result.commands.length,
        }),
      );
    }
    for (const key of [
      "observations",
      "commands",
      "durable",
      "disconnections",
      "replacements",
      "exactReopens",
      "deadlines",
      "cryptoProofs",
      "expectedCryptoFailures",
      "queuePreparations",
      "queueStates",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.diagnostics = h?.diagnostics();
} finally {
  await h?.close().catch(() => {});
  await pg?.close();
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/native-controls-${databaseMode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      databaseMode,
      passed: report.passed ?? false,
      root,
      report: destination,
    }),
  );
}
if (failure) throw failure;
