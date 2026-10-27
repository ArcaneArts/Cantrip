// Unix's pipe owner has two additional failure boundaries. Windows uses its job.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment } from "./process.mjs";
import { HttpFixture } from "./http-fixture.mjs";

const execute = promisify(execFile);
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const quote = (s) => `'${s.replaceAll("'", "'\"'\"'")}'`;
function launch(executable, args, env) {
  const child = spawn(executable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      log = (log + b).slice(-32768);
    });
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, log: () => log };
}
async function finished(process, ms = 10000) {
  let timer;
  try {
    const result = await Promise.race([
      process.completion,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
      }),
    ]);
    assert.equal(
      result.timedOut,
      undefined,
      `Native owner did not exit: ${process.log()}`,
    );
    assert.equal(result.error, undefined, result.error);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function command(pid) {
  try {
    return (
      await execute("ps", ["-p", String(pid), "-o", "comm="])
    ).stdout.trim();
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}
async function stop(bin, root) {
  try {
    await execute(path.join(bin, "pg_ctl"), [
      "-D",
      path.join(root, "data"),
      "stop",
      "-m",
      "fast",
      "-w",
      "-t",
      "10",
    ]);
  } catch (error) {
    if (![1, 3].includes(error.code)) throw error;
  }
}

export async function unixLifecycle({
  executable,
  bin,
  root,
  privateRoot,
  cases,
}) {
  if (process.platform === "win32") return [];
  // Hold the parent pipe open while PostgreSQL exits. A blocking Tokio stdin
  // thread previously proposed for this owner would prevent runtime teardown.
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  let owner, sql;
  try {
    owner = launch(
      executable,
      [
        "--internal-postgres-owner",
        "--data-dir",
        privateRoot,
        "--postgres-bin-dir",
        bin,
        "--port",
        String(port),
      ],
      fixtureEnvironment(root),
    );
    const credentials = JSON.parse(
      await readFile(path.join(privateRoot, "credentials.json"), "utf8"),
    );
    sql = postgres({
      host: "127.0.0.1",
      port,
      username: credentials.username,
      password: credentials.password,
      database: "postgres",
      ssl: false,
      max: 1,
      connect_timeout: 1,
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        assert.equal((await sql`SELECT 1 AS value`)[0].value, 1);
        break;
      } catch (error) {
        if (Date.now() >= deadline || owner.child.exitCode !== null)
          throw error;
        await delay(20);
      }
    }
    await sql.end({ timeout: 2 });
    sql = undefined;
    await stop(bin, privateRoot);
    const completion = await finished(owner);
    assert.equal(completion.code, 0, owner.log());
    cases.push({
      name: "Unix owner exits when PostgreSQL stops with parent pipe still open",
      parentEofSent: false,
      completion,
      passed: true,
    });
  } finally {
    owner?.child.stdin.end();
    await sql?.end({ timeout: 2 });
    await stop(bin, privateRoot);
    if (owner?.child.exitCode === null && owner.child.signalCode === null) {
      try {
        await finished(owner);
      } catch {
        owner.child.kill("SIGKILL");
        await owner.completion;
      }
    }
  }

  // The wrapper records its PID and immediately execs the real initdb. Wait for
  // the actual executable before killing only the server handle we launched.
  const profile = path.join(root, "interrupted initialization");
  const binaries = path.join(root, "initialization binaries");
  const marker = path.join(root, "actual-initdb-pid");
  await mkdir(binaries);
  await writeFile(
    path.join(binaries, "initdb"),
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(marker)}\nexec ${quote(path.join(bin, "initdb"))} "$@"\n`,
    { mode: 0o755 },
  );
  await symlink(path.join(bin, "postgres"), path.join(binaries, "postgres"));
  let initializing, fixture;
  const databaseRoot = path.join(profile, "postgres");
  try {
    const env = {
      ...fixtureEnvironment(profile),
      CANTRIP_POSTGRES_BIN_DIR: binaries,
    };
    initializing = launch(
      executable,
      [
        "--port",
        "0",
        "--database",
        "bundled-postgres",
        "--shutdown-on-stdin-close",
      ],
      env,
    );
    const deadline = Date.now() + 10000;
    let pid, actualCommand;
    for (;;) {
      try {
        pid = Number((await readFile(marker, "utf8")).trim());
        actualCommand = await command(pid);
        if (actualCommand && path.basename(actualCommand) === "initdb") break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.equal(initializing.child.exitCode, null, initializing.log());
      assert.ok(
        Date.now() < deadline,
        `Actual initdb did not reach the interruption barrier: ${initializing.log()}`,
      );
      await delay(1);
    }
    assert.equal(initializing.child.kill("SIGKILL"), true);
    const completion = await finished(initializing);
    assert.equal(completion.signal, "SIGKILL");
    const exitDeadline = Date.now() + 10000;
    let remaining;
    while (
      (remaining = await command(pid)) !== null &&
      Date.now() < exitDeadline
    )
      await delay(20);
    assert.equal(
      remaining,
      null,
      "Owned initialization process must be reaped after parent death",
    );
    const leftovers = (await readdir(databaseRoot)).filter(
      (p) => p.startsWith("initializing-") || p.startsWith("init-password-"),
    );
    assert.deepEqual(
      leftovers,
      [],
      "Cancelled initialization must remove only its own staging files",
    );
    fixture = new HttpFixture({
      kind: "rust",
      executable,
      root,
      name: "initialization-restart",
      databaseMode: "bundled-postgres",
      environment: { CANTRIP_DATA_DIR: profile, CANTRIP_POSTGRES_BIN_DIR: bin },
    });
    await fixture.start();
    await fixture.observe(
      "ready after interrupted initialization",
      "GET",
      "/readyz",
    );
    cases.push({
      name: "Unix main server dies during actual initdb",
      actualCommand,
      initializationPid: pid,
      completion,
      leftovers,
      actualRestartReady: true,
      passed: true,
    });
  } finally {
    initializing?.child.stdin.end();
    if (
      initializing?.child.exitCode === null &&
      initializing.child.signalCode === null
    ) {
      initializing.child.kill("SIGKILL");
      await initializing.completion;
    }
    await fixture?.close();
    await stop(bin, databaseRoot);
  }

  const failedBins = path.join(root, "failed initializer binaries");
  await mkdir(failedBins);
  await writeFile(path.join(failedBins, "initdb"), "#!/bin/sh\nexit 42\n", {
    mode: 0o755,
  });
  for (const occupied of [false, true]) {
    const name = occupied
      ? "existing data promotion failure"
      : "actual initdb failure";
    const profile = path.join(root, name);
    const database = path.join(profile, "postgres");
    const marker = path.join(database, "data", "retained-original");
    if (occupied) {
      await mkdir(path.dirname(marker), { recursive: true });
      await writeFile(
        marker,
        "retain original data after a failed promotion 🦀",
      );
    }
    const fixture = new HttpFixture({
      kind: "rust",
      executable,
      root,
      name,
      databaseMode: "bundled-postgres",
      environment: {
        CANTRIP_DATA_DIR: profile,
        CANTRIP_POSTGRES_BIN_DIR: occupied ? bin : failedBins,
      },
    });
    let diagnostic;
    try {
      try {
        await fixture.start();
      } catch (error) {
        diagnostic = error.message;
      }
      assert.ok(
        diagnostic,
        "Actual failed initializer/promotion must fail server startup",
      );
      assert.match(
        diagnostic,
        occupied
          ? /promote initialized private PostgreSQL cluster/
          : /initdb failed.*42/s,
      );
      if (occupied)
        assert.equal(
          await readFile(marker, "utf8"),
          "retain original data after a failed promotion 🦀",
        );
      const leftovers = (await readdir(database)).filter(
        (p) => p.startsWith("initializing-") || p.startsWith("init-password-"),
      );
      assert.deepEqual(leftovers, []);
      cases.push({
        name: `Unix ${name}`,
        actualErrorReported: true,
        originalRetained: occupied,
        leftovers,
        passed: true,
      });
    } finally {
      await fixture.close();
      await stop(bin, database);
    }
  }
  return cases;
}
