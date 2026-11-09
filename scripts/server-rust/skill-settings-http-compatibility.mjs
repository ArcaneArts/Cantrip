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
  settingsProject as project,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import {
  skillSettingsHttpWorker,
  skillSettingsMarker,
} from "./skill-settings-http-worker.mjs";
import { runSkillSettingsHttpCases } from "./skill-settings-http-cases.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-skill-settings-http-"));
const report = {
  suite: "global-skill-settings-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, h, controller, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
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
        commands: [],
        nativeCalls: [],
        cryptoProofs: 0,
        snapshotProofs: 0,
        durable: [],
        recovery: [],
      };
      outputs.push(result);
      controller = skillSettingsHttpWorker(result, () => h);
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
            id: "unrouted-provider",
            kind: "openai-compatible",
            worker,
          }).slice(0, 1),
        ],
        onCommand: controller.onCommand,
      });
      try {
        await h.live.subscribed("skill-settings-project", [
          { kind: "current-user" },
          { kind: "project", projectId: project },
        ]);
        await runSkillSettingsHttpCases({ h, profile, result, controller });
        await h.live.subscribed("skill-settings-final-barrier", [
          { kind: "current-user" },
          { kind: "project", projectId: project },
        ]);
        result.events = h.live.history
          .filter((e) => e.type === "event" && e.resource === "customization")
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
        result.observations = controller.canonical(result.observations);
        for (const value of [
          ...h.fixture.records.values(),
          h.live.history,
          h.diagnostics(),
        ])
          assert.equal(
            JSON.stringify(value).includes(skillSettingsMarker),
            false,
            "server never receives private skill plaintext",
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
      "nativeCalls",
      "cryptoProofs",
      "snapshotProofs",
      "events",
      "durable",
      "recovery",
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
  await h?.close().catch(() => {});
  await pg?.close();
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/skill-settings-http-${databaseMode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure) await rm(root, { recursive: true, force: true });
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
