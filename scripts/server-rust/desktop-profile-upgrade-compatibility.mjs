// Actual stopped legacy profile -> production desktop preparation -> native
// HTTP writes/restart -> logical reverse conversion -> real packaged Node.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify, parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { configureDesktopServer } from "../desktop-server-runtime.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "native-server",
      "failure-fixture",
      "probe",
      "native-assets",
      "converter",
      "legacy-server",
      "legacy-profile",
      "report",
    ].map((name) => [name, { type: "string" }]),
  ),
});
const executable = path.resolve(values["native-server"]);
const probe = path.resolve(values.probe);
const assets = path.resolve(values["native-assets"]);
const converter = path.resolve(values.converter);
const legacyServer = path.resolve(values["legacy-server"]);
const legacyProfile = path.resolve(values["legacy-profile"]);
const manifest = JSON.parse(
  await readFile(path.join(assets, "native-server.json"), "utf8"),
);
const pglite = path.join(assets, "pglite");
const base = [
  "--bundled-pglite-runtime-dir",
  pglite,
  "--bundled-postgres-bin-dir",
  path.join(assets, manifest.postgres.bin),
];
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-desktop-profile-upgrade-"),
);
const report = { suite: "desktop-profile-upgrade", root, cases: [] };
function record(value) {
  report.cases.push(value);
  console.log(
    JSON.stringify({ event: "profile.upgrade.acceptance.case", ...value }),
  );
}
const execute = promisify(execFile);
const environment = (data) => ({
  ...fixtureEnvironment(data),
  PGLITE_RUNTIME_DIR: pglite,
  CANTRIP_BOOTSTRAP_MODE: "tauri",
});
const copy = (source, destination) =>
  cp(source, destination, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
async function files(directory, relative = "", result = {}) {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await files(directory, name, result);
    else if (entry.isFile())
      result[name] = createHash("sha256")
        .update(await readFile(path.join(directory, name)))
        .digest("hex");
    else assert.fail("fixture contains a non-file asset");
  }
  return result;
}
const events = (output) =>
  output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
async function command(data, args, { allowFailure = false } = {}) {
  try {
    const result = await execute(
      executable,
      [...base, "--shutdown-on-stdin-close", "--data-dir", data, ...args],
      { env: environment(data), maxBuffer: 1024 * 1024 },
    );
    return { code: 0, ...result, events: events(result.stdout) };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
      events: events(error.stdout ?? ""),
    };
  }
}
const upgrade = (data, args = [], options) =>
  command(data, ["--migrate-only", "--upgrade-profile", ...args], options);
const completion = (result) =>
  result.events.find((value) => value.event === "profile.upgrade.completed");
async function request(server, route, options = {}) {
  const response = await fetch(server.origin + route, {
    ...options,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json();
  assert.equal(response.status, 200, route + ": " + JSON.stringify(body));
  return body;
}
async function state(server) {
  return {
    identity: (await request(server, "/api/bootstrap")).server.id,
    theme: (await request(server, "/api/settings")).preferences.theme,
  };
}
async function writeTheme(server, theme) {
  await request(server, "/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ theme }),
  });
  assert.equal((await state(server)).theme, theme);
}
async function native(data) {
  return startServer(
    executable,
    [...base, "--data-dir", data, "--port", "0", "--shutdown-on-stdin-close"],
    { env: environment(data) },
  );
}
let failure;
try {
  const sourceDigest = await files(legacyProfile);
  const missing = path.join(root, "missing-converter");
  await copy(legacyProfile, missing);
  const missingResult = await upgrade(
    missing,
    [
      "--legacy-node",
      path.join(root, "absent-node"),
      "--legacy-profile-converter",
      path.join(converter, "dist/index.mjs"),
    ],
    { allowFailure: true },
  );
  assert.notEqual(missingResult.code, 0);
  assert.match(
    missingResult.stderr,
    /profile.upgrade.legacy-conversion.started/,
  );
  assert.deepEqual(await files(missing), sourceDigest);
  record({
    name: "actual-converter-spawn-failure-retains-original",
    code: missingResult.code,
  });

  const runtime = path.join(root, "runtime");
  await mkdir(runtime);
  await copy(assets, path.join(runtime, "server"));
  await copy(
    executable,
    path.join(
      runtime,
      "server/bin/cantrip-server" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  await copy(
    process.execPath,
    path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
  );
  await copy(converter, path.join(runtime, "profile-converter"));
  await configureDesktopServer(path.join(runtime, "server"), "rust");
  const desktop = path.join(root, "production-launcher");
  await mkdir(desktop);
  await copy(legacyProfile, path.join(desktop, "server"));
  const launchEnvironment = environment(desktop);
  delete launchEnvironment.CANTRIP_DATA_DIR;
  delete launchEnvironment.PGLITE_RUNTIME_DIR;
  let server = await startServer(
    probe,
    [runtime, desktop, "--without-worker"],
    { env: launchEnvironment },
  );
  const initial = await state(server);
  await writeTheme(server, "light");
  await server.close();
  const active = path.join(desktop, "server");
  const selection = JSON.parse(
    await readFile(path.join(active, "server-database.json"), "utf8"),
  );
  assert.equal(selection.runtime, "rust");
  assert.equal(selection.databaseMode, "pglite");
  const journal = await Promise.all(
    (await readdir(desktop))
      .filter(
        (name) =>
          name.startsWith(".cantrip-activation-") && name.endsWith(".json"),
      )
      .map(async (name) =>
        JSON.parse(await readFile(path.join(desktop, name), "utf8")),
      ),
  );
  const activeRealPath = await realpath(active);
  const activation = journal.find(
    (value) =>
      path.toNamespacedPath(value.destination) ===
      path.toNamespacedPath(activeRealPath),
  );
  assert.ok(activation);
  assert.deepEqual(await files(activation.backup), sourceDigest);
  // A second ordinary desktop launch must retain the accepted write. Even an
  // absent converter executable is irrelevant once native ownership is recorded.
  await rm(path.join(runtime, "profile-converter"), { recursive: true });
  server = await startServer(probe, [runtime, desktop, "--without-worker"], {
    env: launchEnvironment,
  });
  assert.deepEqual(await state(server), { ...initial, theme: "light" });
  await writeTheme(server, "system");
  await server.close();
  record({
    name: "production-launcher-converts-and-restarts-without-converter",
    identity: initial.identity,
    originalFiles: Object.keys(sourceDigest).length,
  });

  const bundle = path.join(root, "after-native-writes");
  await command(active, ["--migrate-only", "--export-profile", bundle]);
  const reverse = path.join(root, "reverse-node-profile");
  await execute(
    process.execPath,
    [
      path.join(converter, "dist/index.mjs"),
      "--restore",
      bundle,
      reverse,
      executable,
    ],
    { env: environment(active), maxBuffer: 1024 * 1024 },
  );
  await command(active, ["--migrate-only", "--activate-profile", reverse]);
  const node = await startPackagedNodeServer(legacyServer, environment(active));
  try {
    assert.deepEqual(await state(node), { ...initial, theme: "system" });
    await writeTheme(node, "dark");
  } finally {
    await node.close();
  }
  record({
    name: "post-write-reverse-migration-observed-by-real-node",
    identity: initial.identity,
    latestNativeTheme: "system",
    subsequentNodeTheme: "dark",
  });

  const fresh = path.join(root, "fresh-native");
  const prepared = completion(await upgrade(fresh));
  assert.equal(prepared.upgraded, false);
  await assert.rejects(stat(fresh), { code: "ENOENT" });
  server = await native(fresh);
  const freshIdentity = (await state(server)).identity;
  await writeTheme(server, "dark");
  await server.close();
  const beforeRestart = await files(fresh);
  assert.equal(completion(await upgrade(fresh)).upgraded, false);
  assert.deepEqual(await files(fresh), beforeRestart);
  await rm(path.join(fresh, "server-database.json"));
  const unmarkedDigest = await files(fresh);
  const nativeUpgrade = completion(await upgrade(fresh));
  assert.equal(nativeUpgrade.upgraded, true);
  assert.deepEqual(
    await files(nativeUpgrade.receipt.backupDirectory),
    unmarkedDigest,
  );
  server = await native(fresh);
  assert.deepEqual(await state(server), {
    identity: freshIdentity,
    theme: "dark",
  });
  await server.close();
  record({
    name: "fresh-and-unmarked-native-profiles-upgrade-without-node",
    identity: freshIdentity,
  });

  await writeFile(
    path.join(fresh, "server-database.json"),
    "invalid saved configuration\n",
    { mode: 0o600 },
  );
  const invalidConfigurationDigest = await files(fresh);
  const explicit = completion(await upgrade(fresh, ["--database", "pglite"]));
  assert.equal(explicit.upgraded, true);
  assert.deepEqual(
    await files(explicit.receipt.backupDirectory),
    invalidConfigurationDigest,
  );
  record({
    name: "explicit-native-open-not-gated-by-irrelevant-invalid-metadata",
  });

  // Make the real migration-history read fail after a successful engine open.
  // It must not be misclassified as a legacy-format failure or invoke Node.
  await execute(path.resolve(values["failure-fixture"]), [fresh], {
    env: environment(fresh),
    maxBuffer: 1024 * 1024,
  });
  await rm(path.join(fresh, "server-database.json"));
  const failedDigest = await files(fresh);
  const failed = await upgrade(
    fresh,
    [
      "--legacy-node",
      process.execPath,
      "--legacy-profile-converter",
      path.join(converter, "dist/index.mjs"),
    ],
    { allowFailure: true },
  );
  assert.notEqual(failed.code, 0);
  assert.doesNotMatch(
    failed.stderr,
    /profile.upgrade.legacy-conversion.started/,
  );
  assert.deepEqual(await files(fresh), failedDigest);
  record({
    name: "actual-migration-failure-never-invokes-legacy-converter",
    code: failed.code,
  });

  const retainedMissingRoot = path.join(root, "retained-missing-active-root");
  await rename(fresh, retainedMissingRoot);
  const missingActive = await upgrade(fresh, [], { allowFailure: true });
  assert.notEqual(missingActive.code, 0);
  await assert.rejects(stat(fresh), { code: "ENOENT" });
  assert.deepEqual(await files(retainedMissingRoot), failedDigest);
  record({
    name: "missing-completed-profile-never-becomes-empty-installation",
    code: missingActive.code,
  });

  // Observe a real conversion child before killing its native owner. The old
  // profile must remain unchanged and the child must terminate through EOF.
  const interrupted = path.join(root, "interrupted");
  await copy(legacyProfile, interrupted);
  const child = spawn(
    executable,
    [
      ...base,
      "--data-dir",
      interrupted,
      "--migrate-only",
      "--upgrade-profile",
      "--shutdown-on-stdin-close",
      "--legacy-node",
      process.execPath,
      "--legacy-profile-converter",
      path.join(converter, "dist/index.mjs"),
    ],
    { env: environment(interrupted), stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.resume();
  child.stderr.on("data", (bytes) => {
    output = (output + bytes).slice(-65536);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 60_000;
  let converterPid, nodePid;
  while (!nodePid) {
    assert.equal(child.exitCode, null, output);
    let processes;
    if (process.platform === "win32") {
      const { stdout } = await execute(
        path.resolve(values["failure-fixture"]),
        ["--processes"],
      );
      processes = JSON.parse(stdout).map((entry) => [null, ...entry]);
    } else {
      processes = (await execute("ps", ["-axo", "pid=,ppid=,command="])).stdout
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean);
    }
    const owner = processes.find(
      (match) =>
        Number(match[2]) === child.pid &&
        (process.platform === "win32"
          ? match[3].toLowerCase() === path.basename(executable).toLowerCase()
          : match[3].includes("--internal-profile-converter-owner")),
    );
    const node =
      owner &&
      processes.find(
        (match) =>
          Number(match[2]) === Number(owner[1]) &&
          (process.platform === "win32"
            ? match[3].toLowerCase() ===
              path.basename(process.execPath).toLowerCase()
            : match[3].includes("dist/index.mjs")),
      );
    if (node) {
      converterPid = Number(owner[1]);
      nodePid = Number(node[1]);
    }
    assert.ok(
      Date.now() < deadline,
      "No actual owned Node converter observed: " + output,
    );
    if (!nodePid) await delay(10);
  }
  child.kill("SIGKILL");
  const killed = await closed;
  if (process.platform === "win32") assert.notEqual(killed.code, 0);
  else assert.equal(killed.signal, "SIGKILL");
  for (;;) {
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    if (!alive(converterPid) && !alive(nodePid)) break;
    assert.ok(Date.now() < deadline, "Conversion child outlived its owner");
    await delay(25);
  }
  assert.deepEqual(await files(interrupted), sourceDigest);
  assert.deepEqual(await files(legacyProfile), sourceDigest);
  record({
    name: "real-converter-stops-after-owner-sigkill-original-retained",
    converterPid,
    nodePid,
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  failure = error;
} finally {
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  console.log(
    JSON.stringify({
      suite: report.suite,
      status: report.status,
      root,
      cases: report.cases.length,
    }),
  );
}
if (failure) throw failure;
