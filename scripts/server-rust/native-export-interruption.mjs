import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
let observerBinary;
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
export async function nativeExportInterruption({
  executable,
  args,
  environment,
  root,
  mode,
  pgDump,
  observe,
}) {
  const observer = await (observerBinary ??= buildRustExample(
    "native-pg-dump-observer",
  ));
  const witness = path.join(root, "native-export-" + mode + ".witness");
  const destination = path.join(root, "native-interrupted-" + mode + ".sql");
  const altered = args.slice();
  altered[altered.indexOf("--export-sql") + 1] = destination;
  altered[altered.indexOf("--pg-dump-path") + 1] = observer;
  const before = new Set(await readdir(root));
  const child = spawn(executable, altered, {
    env: {
      ...environment,
      CANTRIP_TEST_REAL_PG_DUMP: pgDump,
      CANTRIP_TEST_DUMP_WITNESS: witness,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    exited,
    failure,
    pids;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve((exited = { code, signal })));
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  exit.catch(() => {});
  completion.catch(() => {});
  const result = {};
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      const value = await readFile(witness, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (value !== null) {
        assert.equal(value.trim(), "1");
        break;
      }
      assert.equal(exited, undefined, stderr);
      assert.ok(
        Date.now() < deadline,
        "real pg_dump must emit a fixture row before interruption",
      );
      await delay(20);
    }
    pids = JSON.parse(
      await readFile(witness.replace(/\.witness$/, ".pids"), "utf8"),
    );
    assert.equal(pids.actualFixtureRowObserved, true);
    child.kill("SIGKILL");
    result.parentExit = await exit;
    assert.notEqual(result.parentExit.code, 0);
  } catch (error) {
    failure = error;
    if (!exited) child.kill("SIGKILL");
    await exit.catch(() => {});
  } finally {
    await writeFile(witness.replace(/\.witness$/, ".release"), "release");
    await completion.catch((error) => {
      failure ??= error;
    });
  }
  if (failure) throw failure;
  const deadline = Date.now() + 30000;
  for (const pid of [pids.observer, pids.pgDump]) {
    while (running(pid)) {
      assert.ok(
        Date.now() < deadline,
        "owned dump process must exit after its parent connection closes: " +
          pid,
      );
      await delay(20);
    }
  }
  result.processes = pids;
  result.noOrphanProcesses = true;
  assert.equal(stdout.includes('"database.export.completed"'), false);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
  result.staging = [];
  for (const name of await readdir(root))
    if (name.startsWith(".cantrip-export-") && !before.has(name)) {
      const file = path.join(root, name),
        info = await stat(file);
      assert.equal(
        info.size,
        0,
        "SQL was not published or written before dump completion",
      );
      if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
      result.staging.push({ name, size: info.size });
      await unlink(file);
    }
  result.recovery = [];
  for (;;) {
    try {
      await observe();
      break;
    } catch (error) {
      result.recovery.push(error.message);
      assert.equal(mode, "bundled-postgres");
      assert.match(error.message, /postmaster\.pid.*already exists/s);
      assert.ok(Date.now() < deadline);
      await delay(100);
    }
  }
  result.noPublishedDestination = true;
  return result;
}
