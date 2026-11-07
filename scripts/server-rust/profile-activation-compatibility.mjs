// Actual legacy profile -> prepared native profile -> interrupted activation ->
// native HTTP writes -> reverse conversion -> activation -> packaged Node writes.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  exportLegacyProfile,
  restoreLegacyProfile,
} from "../database-transfer/legacy-profile.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";

const { values } = parseArgs({
  options: {
    "native-server": { type: "string" },
    probe: { type: "string" },
    "native-assets": { type: "string" },
    "legacy-server": { type: "string" },
    "legacy-profile": { type: "string" },
    "external-url": { type: "string" },
    "immutable-parent": { type: "boolean", default: false },
    report: { type: "string" },
  },
});
const executable = path.resolve(values["native-server"]);
const probe = path.resolve(values.probe);
const assets = path.resolve(values["native-assets"]);
const legacyServer = path.resolve(values["legacy-server"]);
const legacyProfile = path.resolve(values["legacy-profile"]);
const manifest = JSON.parse(
  await readFile(path.join(assets, "native-server.json"), "utf8"),
);
const pg = path.join(assets, manifest.postgres.bin);
const pglite = path.join(assets, "pglite");
const base = [
  "--bundled-pglite-runtime-dir",
  pglite,
  "--bundled-postgres-bin-dir",
  pg,
];
// The bounded converter invokes the native packer in a separate process.
process.env.PGLITE_RUNTIME_DIR = pglite;
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-profile-activation-"));
const report = { suite: "profile-directory-activation", root, cases: [] };
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
let sql, failure;
const databases = [];
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
    else assert.fail("fixture profile has no special files");
  }
  return result;
}
const environment = (data) => ({
  ...fixtureEnvironment(data),
  PGLITE_RUNTIME_DIR: pglite,
  CANTRIP_BOOTSTRAP_MODE: "tauri",
});
async function command(args, env) {
  const result = await execute(executable, [...base, ...args], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
async function request(server, route, options = {}) {
  const response = await fetch(server.origin + route, {
    ...options,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
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
  assert.equal(
    (await request(server, "/api/settings")).preferences.theme,
    theme,
  );
}
async function interrupt(prepared, active, step) {
  const child = spawn(probe, [prepared, active, step], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-262144);
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      completion.then(
        (result) =>
          reject(
            new Error(
              "Probe exited before real rename witness: " +
                JSON.stringify(result) +
                "\n" +
                diagnostics,
            ),
          ),
        reject,
      );
      timer = setTimeout(
        () => reject(new Error("No actual activation witness: " + diagnostics)),
        30_000,
      );
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (
            event.event === "profile.activation.paused" &&
            event.step === step
          )
            resolve();
        } catch {}
      });
    });
    child.kill("SIGKILL");
    const result = await completion;
    assert.notEqual(result.code, 0);
    return result;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await completion;
    }
  }
}
try {
  const original = await files(legacyProfile);
  const baselineRoot = path.join(root, "baseline-node");
  await cp(legacyProfile, baselineRoot, { recursive: true });
  const baseline = await startPackagedNodeServer(
    legacyServer,
    environment(baselineRoot),
  );
  let expected;
  try {
    expected = await state(baseline);
  } finally {
    await baseline.close();
  }
  report.original = expected;
  const bundle = path.join(root, "legacy-logical");
  report.export = await exportLegacyProfile({
    source: legacyProfile,
    output: bundle,
    executable,
  });
  assert.deepEqual(await files(legacyProfile), original);
  if (values["external-url"])
    sql = postgres(values["external-url"], { max: 1 });
  for (const mode of [
    "pglite",
    "bundled-postgres",
    ...(sql ? ["postgres"] : []),
  ]) {
    for (const step of [
      "prepared-moved",
      "previous-retained",
      "new-published",
      "completed",
    ]) {
      const directory = path.join(root, mode + "-" + step);
      await mkdir(directory);
      const active = path.join(directory, "active"),
        prepared = path.join(directory, "prepared");
      await cp(legacyProfile, active, { recursive: true });
      const oldBytes = await files(active);
      const env = environment(active);
      const initial = { ...environment(prepared), CANTRIP_DATABASE_MODE: mode };
      if (sql) {
        if (mode === "postgres") {
          const name =
            "cantrip_activation_" +
            path.basename(root).replaceAll("-", "").toLowerCase() +
            "_" +
            databases.length;
          await sql`CREATE DATABASE ${sql(name)}`;
          databases.push(name);
          const url = new URL(values["external-url"]);
          url.pathname = "/" + name;
          initial.DATABASE_URL = url.href;
        }
      }
      await command(["--migrate-only", "--restore-profile", bundle], initial);
      const killed = await interrupt(prepared, active, step);
      // Normal startup itself must finish recovery before reading the backend
      // configuration; no special recovery flag is passed to this server.
      let native = await startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
      let retry;
      const nextTheme = expected.theme === "dark" ? "light" : "dark";
      try {
        assert.deepEqual(await state(native), expected);
        assert.equal(
          (await request(native, "/readyz")).database.engine,
          mode === "pglite" ? "pglite" : "postgres",
        );
        await writeTheme(native, nextTheme);
        // The real serving lease holds the exclusive activation retry until
        // serving stops, then the retry must keep the newly accepted write.
        let ended = false;
        retry = command(
          [
            "--data-dir",
            active,
            "--migrate-only",
            "--activate-profile",
            prepared,
          ],
          env,
        ).then((result) => {
          ended = true;
          return result;
        });
        retry.catch(() => {});
        await delay(100);
        assert.equal(
          ended,
          false,
          "activation must wait for the live server lease",
        );
        assert.equal((await state(native)).theme, nextTheme);
      } finally {
        await native.close();
      }
      const receipt = (await retry).find(
        (event) => event.event === "profile.activation.completed",
      ).receipt;
      assert.deepEqual(await files(receipt.backupDirectory), oldBytes);
      native = await startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
      try {
        assert.deepEqual(await state(native), {
          ...expected,
          theme: nextTheme,
        });
      } finally {
        await native.close();
      }
      const reverseBundle = path.join(directory, "after-native");
      await command(
        [
          "--migrate-only",
          "--export-profile",
          reverseBundle,
          "--pg-dump-path",
          path.join(
            pg,
            process.platform === "win32" ? "pg_dump.exe" : "pg_dump",
          ),
        ],
        env,
      );
      const reverse = path.join(directory, "reversed");
      await restoreLegacyProfile({
        source: reverseBundle,
        output: reverse,
        executable,
      });
      const reversedEvents = await command(
        ["--data-dir", active, "--migrate-only", "--activate-profile", reverse],
        env,
      );
      const reverseReceipt = reversedEvents.find(
        (event) => event.event === "profile.activation.completed",
      ).receipt;
      const node = await startPackagedNodeServer(legacyServer, env);
      try {
        assert.deepEqual(await state(node), { ...expected, theme: nextTheme });
        await writeTheme(node, expected.theme);
      } finally {
        await node.close();
      }
      report.cases.push({
        mode,
        step,
        killed,
        normalStartupRecoveredSavedBackend: true,
        originalBytesRetained: true,
        nativeAcceptedWrite: true,
        activationRetryRetainedWrite: true,
        reverseActivationRetainedNativeWrite: true,
        packagedNodeAcceptedAnotherWrite: true,
        receipt,
        reverseReceipt,
      });
    }
  }
  if (sql) {
    const directory = path.join(root, "shared-external-profile");
    await mkdir(directory);
    const active = path.join(directory, "active");
    const prepared = path.join(directory, "prepared");
    const name =
      "cantrip_activation_shared_" +
      path.basename(root).replaceAll("-", "").toLowerCase();
    await sql`CREATE DATABASE ${sql(name)}`;
    databases.push(name);
    const url = new URL(values["external-url"]);
    url.pathname = "/" + name;
    await command(["--migrate-only", "--restore-profile", bundle], {
      ...environment(active),
      CANTRIP_DATABASE_MODE: "postgres",
      DATABASE_URL: url.href,
    });
    const env = environment(active);
    const launch = () =>
      startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
    const first = await launch();
    let second, retry;
    let ended = false;
    try {
      second = await launch();
      assert.deepEqual(await state(first), expected);
      assert.deepEqual(await state(second), expected);
      await writeTheme(first, expected.theme === "dark" ? "light" : "dark");
      assert.equal(
        (await state(second)).theme,
        expected.theme === "dark" ? "light" : "dark",
      );
      // The external database remains the same; copy the stable profile files
      // to prepare a directory switch while both shared leases are held.
      await cp(active, prepared, { recursive: true });
      retry = command(
        [
          "--data-dir",
          active,
          "--migrate-only",
          "--activate-profile",
          prepared,
        ],
        env,
      ).then((result) => {
        ended = true;
        return result;
      });
      retry.catch(() => {});
      await delay(100);
      assert.equal(ended, false);
      await first.close();
      await delay(100);
      assert.equal(
        ended,
        false,
        "the remaining native server must still exclude activation",
      );
      await writeTheme(second, expected.theme);
    } finally {
      try {
        if (second) await second.close();
      } finally {
        await first.close();
      }
    }
    await retry;
    const reopened = await launch();
    try {
      assert.deepEqual(await state(reopened), expected);
    } finally {
      await reopened.close();
    }
    report.sharedExternalReaders = {
      twoActualNativeProcesses: true,
      sameProfileAndDatabase: true,
      sharedWriteObserved: true,
      activationWaitedForBoth: true,
      latestPeerWriteRetainedAfterActivation: true,
    };
  }
  {
    const directory = path.join(root, "lost-uncommitted-candidate");
    await mkdir(directory);
    const active = path.join(directory, "active"),
      prepared = path.join(directory, "prepared");
    await command(
      ["--migrate-only", "--restore-profile", bundle],
      environment(active),
    );
    const env = environment(active);
    const launch = () =>
      startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
    let server = await launch();
    const acceptedTheme = expected.theme === "dark" ? "light" : "dark";
    try {
      await writeTheme(server, acceptedTheme);
    } finally {
      await server.close();
    }
    await cp(active, prepared, { recursive: true });
    await interrupt(prepared, active, "prepared-moved");
    const incoming = (await readdir(directory)).filter((name) =>
      name.startsWith(".cantrip-activation-incoming-"),
    );
    assert.equal(incoming.length, 1);
    await rm(path.join(directory, incoming[0]), { recursive: true });
    server = await launch();
    try {
      assert.deepEqual(await state(server), {
        ...expected,
        theme: acceptedTheme,
      });
      assert.ok(
        server.events.some(
          (event) =>
            event.event === "profile.activation.aborted" &&
            event.activeProfileRetained === true,
        ),
      );
      await writeTheme(server, expected.theme);
    } finally {
      await server.close();
    }
    report.lostUncommittedCandidate = {
      actualCandidateRemovedAfterKill: true,
      healthyActiveProfileReopened: true,
      acceptedNativeWriteRetained: true,
      nextNativeWriteSucceeded: true,
    };

    const missing = path.join(root, "both-profiles-missing");
    await mkdir(missing);
    const missingActive = path.join(missing, "active"),
      missingPrepared = path.join(missing, "prepared");
    await cp(active, missingActive, { recursive: true });
    await cp(active, missingPrepared, { recursive: true });
    await interrupt(missingPrepared, missingActive, "prepared-moved");
    await rm(missingActive, { recursive: true });
    const absent = (await readdir(missing)).filter((name) =>
      name.startsWith(".cantrip-activation-incoming-"),
    );
    assert.equal(absent.length, 1);
    await rm(path.join(missing, absent[0]), { recursive: true });
    let rejected;
    try {
      await execute(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        {
          env: environment(missingActive),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "loss of both profiles must fail actual startup");
    assert.equal(
      rejected.code,
      1,
      "startup must fail on recovery, without waiting for a live empty server",
    );
    await assert.rejects(stat(missingActive), { code: "ENOENT" });
    report.bothProfilesMissing = {
      actualDirectoriesRemoved: true,
      startupExitCode: rejected.code,
      noFreshDatabaseCreated: true,
    };
  }
  {
    const directory = path.join(root, "completed-active-missing");
    await mkdir(directory);
    const active = path.join(directory, "active"),
      prepared = path.join(directory, "prepared");
    await cp(path.join(root, "lost-uncommitted-candidate", "active"), active, {
      recursive: true,
    });
    await cp(active, prepared, { recursive: true });
    const env = environment(active);
    const receipt = (
      await command(
        [
          "--data-dir",
          active,
          "--migrate-only",
          "--activate-profile",
          prepared,
        ],
        env,
      )
    ).find((event) => event.event === "profile.activation.completed").receipt;
    const previousBytes = await files(receipt.backupDirectory);
    const latestTheme = expected.theme === "dark" ? "light" : "dark";
    const launch = () =>
      startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
    let server = await launch();
    try {
      await writeTheme(server, latestTheme);
    } finally {
      await server.close();
    }
    const latest = path.join(directory, "latest-accepted-state");
    await command(
      [
        "--migrate-only",
        "--export-profile",
        latest,
        "--pg-dump-path",
        path.join(pg, process.platform === "win32" ? "pg_dump.exe" : "pg_dump"),
      ],
      env,
    );
    await rm(active, { recursive: true });
    let rejected;
    try {
      await execute(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected);
    assert.equal(rejected.code, 1);
    await assert.rejects(stat(active), { code: "ENOENT" });
    assert.deepEqual(await files(receipt.backupDirectory), previousBytes);
    // A real, explicit restore of the latest accepted state must remain usable;
    // an old completion record must not gate the actual repair operation.
    await command(["--migrate-only", "--restore-profile", latest], env);
    server = await launch();
    try {
      assert.deepEqual(await state(server), {
        ...expected,
        theme: latestTheme,
      });
      await writeTheme(server, expected.theme);
    } finally {
      await server.close();
    }
    assert.deepEqual(await files(receipt.backupDirectory), previousBytes);
    report.completedActiveMissing = {
      startupFailedWithoutReset: true,
      backupRetained: true,
      explicitLatestRestoreSucceeded: true,
      latestAcceptedWriteRecovered: true,
      nextNativeWriteSucceeded: true,
    };
  }
  if (values["immutable-parent"]) {
    const parent = path.join(root, "immutable-parent"),
      data = path.join(parent, "data");
    await mkdir(parent);
    // Make an independent writable data copy whose parent has no existing lock.
    await cp(path.join(root, "pglite-completed", "active"), data, {
      recursive: true,
    });
    // That active profile is now legacy after the reverse test; restore its
    // current logical data into a fresh native profile inside the same parent.
    const logical = path.join(root, "immutable-logical");
    await exportLegacyProfile({ source: data, output: logical, executable });
    const nativeData = path.join(parent, "native-data");
    await command(
      ["--migrate-only", "--restore-profile", logical],
      environment(nativeData),
    );
    // Move the completed profile to a different basename to ensure this parent
    // has no pre-existing lock for the path used by the serving process.
    const finalData = path.join(parent, "serving-data");
    const { rename } = await import("node:fs/promises");
    await rename(nativeData, finalData);
    await chmod(parent, 0o500);
    try {
      await assert.rejects(
        writeFile(path.join(parent, "actual-write-attempt"), "x"),
        (error) => ["EACCES", "EPERM", "EROFS"].includes(error.code),
      );
      const recovery = await command(
        [
          "--data-dir",
          finalData,
          "--migrate-only",
          "--recover-profile-activation",
        ],
        environment(finalData),
      );
      assert.equal(
        recovery.find((event) => event.event === "profile.activation.recovered")
          .receipt,
        null,
      );
      const server = await startServer(
        executable,
        [...base, "--port", "0", "--shutdown-on-stdin-close"],
        { env: environment(finalData) },
      );
      try {
        assert.deepEqual(await state(server), expected);
        await writeTheme(server, expected.theme === "dark" ? "light" : "dark");
      } finally {
        await server.close();
      }
      report.immutableParent = {
        actualParentWriteRejected: true,
        explicitNoopRecoverySucceeded: true,
        writableChildServedAndAcceptedWrite: true,
      };
    } finally {
      await chmod(parent, 0o700);
    }
  }
  assert.deepEqual(await files(legacyProfile), original);
  report.originalBytePreserved = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (sql) {
    try {
      for (const name of databases)
        await sql`DROP DATABASE ${sql(name)} WITH (FORCE)`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  if (values.report) {
    await mkdir(path.dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    root,
    cases: report.cases.length,
    originalBytePreserved: report.originalBytePreserved,
  }),
);
