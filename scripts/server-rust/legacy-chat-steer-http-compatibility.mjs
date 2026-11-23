// Production HTTP routers, worker WebSocket/crypto and CodexAppServer steering.
// The native app-server RPC and initial retained turn are controlled.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import {
  configureSteer,
  legacySteerCases,
} from "./legacy-chat-steer-http-cases.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const databaseMode = option("--database") ?? "pglite";
const profiles = ["none", "password", "accounts"];
const selected = option("--profile");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
assert.ok(!selected || profiles.includes(selected));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-legacy-chat-steer-"));
const report = {
  suite: "legacy-chat-steer-http",
  databaseMode,
  root,
  profiles: [],
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of profiles.filter(
    (name) => !selected || name === selected,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        commands: [],
        nativeCalls: [],
        retained: {},
      };
      outputs.push(result);
      const cases = legacySteerCases(
        result,
        path.join(root, profile, kind, "worker-files"),
      );
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: configureSteer,
        onCommand: cases.handle,
        liveSqlFixture: true,
      });
      try {
        await cases.run(h, profile);
        const { origin } = h.fixture.server;
        await h.close();
        await h.fixture.start({ port: Number(new URL(origin).port) });
        assert.equal(h.fixture.server.origin, origin);
        result.comparison = await cases.reopened(h);
        result.retainedRestarts = 1;
      } finally {
        cases.closeRuntime();
        result.diagnostics = h.diagnostics();
        await h.close();
      }
      console.log(
        JSON.stringify({
          profile,
          kind,
          http: result.observations.length,
          nativeCalls: result.nativeCalls.length,
          retainedRestarts: result.retainedRestarts,
        }),
      );
    }
    for (const key of Object.keys(outputs[0].comparison)) {
      assert.deepEqual(
        outputs[1].comparison[key],
        outputs[0].comparison[key],
        `${profile} ${key} differs between the production routers`,
      );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = String(error.stack ?? error);
  console.error(error);
} finally {
  await pg?.close();
  if (option("--report"))
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  if (!process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
