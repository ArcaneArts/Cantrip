import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot } from "./build.mjs";
import { restoreLegacyProfile } from "../database-transfer/legacy-profile.mjs";
import { inspect } from "node:util";

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
export async function rejectedProfileImport({
  executable,
  bundle,
  root,
  mode,
  environment,
  run,
}) {
  const altered = path.join(root, "rejected-bundle-" + mode);
  await cp(bundle, altered, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const sentinel = "private-profile-restore-sentinel-" + mode;
  const sql = Buffer.concat([
    await readFile(path.join(altered, "database.sql")),
    Buffer.from(
      "\nDO $failure$ BEGIN RAISE EXCEPTION '" +
        sentinel +
        "'; END $failure$;\n",
    ),
  ]);
  await writeFile(path.join(altered, "database.sql"), sql);
  const manifest = JSON.parse(
    await readFile(path.join(altered, "manifest.json"), "utf8"),
  );
  manifest.sqlBytes = sql.length;
  manifest.sqlSha256 = createHash("sha256").update(sql).digest("hex");
  await writeFile(
    path.join(altered, "manifest.json"),
    JSON.stringify(manifest),
  );
  const destination = path.join(root, "rejected-profile-" + mode);
  const before = new Set(await readdir(root));
  let nativeFailure;
  try {
    await run(
      executable,
      [
        "--data-dir",
        destination,
        "--migrate-only",
        "--restore-profile",
        altered,
      ],
      environment,
    );
  } catch (error) {
    nativeFailure = error;
  }
  assert.ok(nativeFailure, "the actual SQL exception must fail the import");
  assert.match(nativeFailure.stderr, /SQLSTATE P0001/);
  for (const text of [
    nativeFailure.stdout,
    nativeFailure.stderr,
    inspect(nativeFailure),
  ])
    assert.equal(
      text.includes(sentinel),
      false,
      "SQL row values remain private in ordinary diagnostics",
    );
  assert.equal(
    nativeFailure.stdout.includes('"profile.restore.completed"'),
    false,
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(root)).filter(
      (name) => name.startsWith(".cantrip-profile-") && !before.has(name),
    ),
    [],
  );
  let legacyFailure;
  const legacyDestination = path.join(root, "rejected-legacy-profile-" + mode);
  try {
    await restoreLegacyProfile({
      source: altered,
      output: legacyDestination,
      executable,
    });
  } catch (error) {
    legacyFailure = error;
  }
  assert.ok(
    legacyFailure,
    "the real JavaScript PGlite exception must fail reverse conversion",
  );
  assert.equal(
    legacyFailure.original().message.includes(sentinel),
    true,
    "the bounded converter retains actual private SQL diagnostics for explicit inspection",
  );
  assert.equal(inspect(legacyFailure).includes(sentinel), false);
  await assert.rejects(stat(legacyDestination), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(root)).filter(
      (name) =>
        name.startsWith(".cantrip-legacy-profile-") && !before.has(name),
    ),
    [],
  );
  return {
    nativeSqlstate: "P0001",
    noPublishedPartialProfile: true,
    redactedNativeDiagnostics: true,
    redactedLegacyDiagnostics: true,
    retainedPrivateCause: true,
  };
}
export async function interruptedProfileImport({
  executable,
  bundle,
  root,
  mode,
  environment,
  run,
}) {
  const altered = path.join(root, "interrupted-bundle-" + mode);
  await cp(bundle, altered, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const witness = path.join(root, "profile-sql-" + mode + ".witness");
  const sql = Buffer.concat([
    await readFile(path.join(altered, "database.sql")),
    Buffer.from(
      "\nCOPY (SELECT 1) TO '" +
        witness.replaceAll("'", "''") +
        "'; SELECT pg_sleep(60);\n",
    ),
  ]);
  await writeFile(path.join(altered, "database.sql"), sql);
  const manifest = JSON.parse(
    await readFile(path.join(altered, "manifest.json"), "utf8"),
  );
  manifest.sqlBytes = sql.length;
  manifest.sqlSha256 = createHash("sha256").update(sql).digest("hex");
  await writeFile(
    path.join(altered, "manifest.json"),
    JSON.stringify(manifest),
  );
  const destination = path.join(root, "interrupted-profile-" + mode);
  const before = new Set(await readdir(root));
  const child = spawn(
    executable,
    ["--data-dir", destination, "--migrate-only", "--restore-profile", altered],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    exited;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve((exited = { code, signal })));
  });
  const complete = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  exit.catch(() => {});
  complete.catch(() => {});
  const result = { staging: [], postmasters: [] };
  let failure;
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      const bytes = await readFile(witness, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (bytes !== null) {
        assert.equal(bytes.trim(), "1");
        break;
      }
      assert.equal(exited, undefined, stderr);
      assert.ok(
        Date.now() < deadline,
        "actual SQL must create its witness before interruption",
      );
      await delay(20);
    }
    for (const name of await readdir(root))
      if (name.startsWith(".cantrip-profile-") && !before.has(name)) {
        const staging = path.join(root, name);
        result.staging.push(staging);
        if (process.platform !== "win32")
          assert.equal((await stat(staging)).mode & 0o777, 0o700);
        if (mode === "bundled-postgres") {
          const pidFile = path.join(
            staging,
            "profile",
            "postgres",
            "data",
            "postmaster.pid",
          );
          const pid = Number(
            (await readFile(pidFile, "utf8")).split(/\r?\n/)[0],
          );
          assert.ok(Number.isSafeInteger(pid) && pid > 0);
          result.postmasters.push(pid);
        }
      }
    assert.ok(result.staging.length > 0);
    child.kill("SIGKILL");
    result.exit = await exit;
    assert.notEqual(result.exit.code, 0);
    await complete;
    await assert.rejects(
      readFile(path.join(destination, "server-profile-receipt.json")),
      { code: "ENOENT" },
    );
    assert.equal(stdout.includes('"profile.restore.completed"'), false);
  } catch (error) {
    failure = error;
    if (!exited) child.kill("SIGKILL");
    await complete.catch(() => {});
  }
  if (failure) throw failure;
  const deadline = Date.now() + 30000;
  for (const pid of result.postmasters)
    while (running(pid)) {
      assert.ok(
        Date.now() < deadline,
        "private postmaster must exit after its owner dies",
      );
      await delay(20);
    }
  for (const staging of result.staging)
    await rm(staging, { recursive: true, force: true });
  // The original valid bundle is retried into the same destination and the same
  // external database; an interrupted transaction must leave no committed load.
  const recovered = await run(
    executable,
    ["--data-dir", destination, "--migrate-only", "--restore-profile", bundle],
    environment,
  );
  assert.ok(
    recovered.some((value) => value.event === "profile.restore.completed"),
  );
  result.recovered = true;
  result.noPublishedPartialProfile = true;
  result.noOrphanPostmasters = true;
  return result;
}
