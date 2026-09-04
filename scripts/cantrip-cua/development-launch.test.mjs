import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  developmentWorkerEnvironment,
  runDevelopmentWorker,
} from "./development-launch.mjs";
import { developmentCuaPaths } from "./development.mjs";

test("development launch uses the installed named profile, never transient build output", () => {
  const environment = {
    CANTRIP_DEV_PROFILE: "browser-test",
    EXISTING: "retained",
  };
  const options = {
    environment,
    homeDirectory: path.resolve("fixture-home"),
    platform: "darwin",
  };
  const projected = developmentWorkerEnvironment(options);
  assert.equal(projected.CANTRIP_CUA_BIN, developmentCuaPaths(options).binary);
  assert.equal(projected.CANTRIP_DEV_PROFILE, "browser-test");
  assert.equal(projected.EXISTING, "retained");
  assert.equal(environment.CANTRIP_CUA_BIN, undefined);
  assert.equal(
    developmentWorkerEnvironment({
      ...options,
      environment: {
        ...environment,
        PWD: "/other/worktree",
        CARGO_TARGET_DIR: "/transient/build",
      },
    }).CANTRIP_CUA_BIN,
    projected.CANTRIP_CUA_BIN,
  );
  assert.equal(
    developmentWorkerEnvironment({ ...options, profileName: "desktop-test" })
      .CANTRIP_DEV_PROFILE,
    "desktop-test",
  );
  assert.throws(() =>
    developmentWorkerEnvironment({ ...options, profileName: "../escape" }),
  );
});

test("explicit development executable overrides remain exact", () => {
  for (const override of [
    "",
    "relative/helper",
    "/missing/helper",
    " padded ",
  ]) {
    assert.equal(
      developmentWorkerEnvironment({
        environment: { CANTRIP_CUA_BIN: override },
      }).CANTRIP_CUA_BIN,
      override,
    );
  }
});

test("worker bootstrap projects environment before loading the unchanged tsx watch CLI", async () => {
  const environment = { CANTRIP_DEV_PROFILE: "direct-test" };
  const argv = [process.execPath, "/launcher.mjs", "--custom-argument"];
  const cli = path.resolve("fixture-cli.mjs");
  const worker = path.resolve("fixture-worker.ts");
  let calls = 0;
  await runDevelopmentWorker({
    environment,
    argv,
    cliUrl: pathToFileURL(cli).href,
    workerUrl: pathToFileURL(worker),
    loadCli: async () => {
      calls += 1;
      assert.equal(
        environment.CANTRIP_CUA_BIN,
        developmentCuaPaths({ environment }).binary,
      );
      assert.deepEqual(argv, [
        process.execPath,
        cli,
        "watch",
        worker,
        "--custom-argument",
      ]);
    },
  });
  assert.equal(calls, 1);
});

test("browser, direct-worker, and desktop development use the shared projection", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const worker = JSON.parse(
    await readFile(path.join(root, "cantrip_worker/package.json"), "utf8"),
  );
  const repository = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const desktop = await readFile(path.join(root, "scripts/devtop.mjs"), "utf8");
  assert.equal(
    worker.scripts.dev,
    "node ../scripts/cantrip-cua/development-launch.mjs",
  );
  assert.match(repository.scripts.dev, /pnpm --filter @cantrip\/worker dev/u);
  assert.match(
    desktop,
    /developmentWorkerEnvironment\(\{ profileName: developmentProfile \}\)/u,
  );
  assert.ok(
    desktop.indexOf("developmentWorkerEnvironment({") <
      desktop.indexOf('runPnpm(["run", "dev:prepare"])'),
  );
  assert.match(desktop, /env: process\.env/u);
});
