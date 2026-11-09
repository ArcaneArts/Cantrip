// Actual worker-authenticated HTTP routes, canonical persistence and unchanged
// worker queue client. Native execution/product acceptance is tracked separately.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
} from "./native-event-http-setup.mjs";
import { literal } from "./project-target-state.mjs";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.ts";
import { nativeQueueHttpCases } from "./native-queue-http-cases.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-queue-http-"));
const report = {
  suite: "actual-native-queue-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
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
        cryptoProofs: 0,
        workerSdkOperations: 0,
        sdkObservations: [],
        queueNotifications: 0,
      };
      outputs.push(result);
      let client;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        passwordHash,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        result,
        configure: (owner) => [
          ...seedEventChats(owner),
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('queue-model',${literal(owner)},'Controlled native queue')`,
        ],
        onCommand: async (command) => {
          if (command.type === "chat.queue.changed") {
            assert.ok(client, "actual queue client initialized");
            await client.read({ session: h.prepared[command.chatId].session });
            result.queueNotifications++;
            return null;
          }
        },
      }));
      try {
        client = new ManagedNativeQueueClient({
          serverUrl: h.fixture.server.origin,
          workerId: worker,
          token: () => h.credential,
        });
        h.prepared = await prepareEventCommands(h);
        await nativeQueueHttpCases({ h, client, result });
        result.diagnostics = h.diagnostics();
      } finally {
        await h.close();
        active = null;
      }
    }
    for (const key of [
      "observations",
      "cryptoProofs",
      "workerSdkOperations",
      "sdkObservations",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
