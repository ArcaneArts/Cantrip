// Pause only the unreaped owner child we launched. Its live postmaster remains
// untouched while a replacement actually attempts ownership of the same store.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { fixtureEnvironment } from "./process.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
async function port() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}
export async function ownershipHandoff({
  executable,
  bin,
  root,
  privateRoot,
  cases,
  launch,
  finished,
  stop,
}) {
  const entry = {
    name: "Unix immediate ownership handoff waits for old postmaster shutdown",
  };
  cases.push(entry);
  const credentials = JSON.parse(
    await readFile(path.join(privateRoot, "credentials.json"), "utf8"),
  );
  const firstPort = await port(),
    secondPort = await port();
  const database = (value) =>
    postgres({
      host: "127.0.0.1",
      port: value,
      username: credentials.username,
      password: credentials.password,
      database: "postgres",
      ssl: false,
      max: 1,
      connect_timeout: 1,
    });
  const start = (value) =>
    launch(
      executable,
      [
        "--internal-postgres-owner",
        "--data-dir",
        privateRoot,
        "--postgres-bin-dir",
        bin,
        "--port",
        String(value),
      ],
      fixtureEnvironment(root),
    );
  let first,
    second,
    sql,
    paused = false;
  try {
    first = start(firstPort);
    sql = database(firstPort);
    await eventually(
      () =>
        sql`SELECT 1 AS value`.then(
          (rows) => ({ rows }),
          (error) => ({ error: String(error) }),
        ),
      (observed) => {
        assert.equal(observed.error, undefined);
        assert.equal(observed.rows[0].value, 1);
      },
      10000,
    );
    await sql`CREATE TABLE IF NOT EXISTS private_handoff_witness(id integer PRIMARY KEY,value text NOT NULL)`;
    await sql`INSERT INTO private_handoff_witness(id,value) VALUES(1,'retained private data 🦀') ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
    await sql.end({ timeout: 2 });
    sql = undefined;
    assert.equal(first.child.kill("SIGSTOP"), true);
    paused = true;
    first.child.stdin.end();
    second = start(secondPort);
    await eventually(
      () => ({
        log: second.log(),
        code: second.child.exitCode,
        signal: second.child.signalCode,
      }),
      (observed) => {
        assert.equal(observed.code, null, observed.log);
        assert.equal(observed.signal, null, observed.log);
        assert.ok(
          observed.log.includes('"event":"database.private-owner.waiting"'),
          "Replacement has actually attempted the occupied OS lock",
        );
      },
      10000,
    );
    entry.waitingLog = second.log();
    assert.equal(first.child.kill("SIGCONT"), true);
    paused = false;
    entry.oldOwner = await finished(first);
    assert.equal(entry.oldOwner.code, 0, first.log());
    sql = database(secondPort);
    const retained = await eventually(
      () =>
        sql`SELECT value FROM private_handoff_witness WHERE id=1`.then(
          (rows) => ({ rows }),
          (error) => ({ error: String(error) }),
        ),
      (observed) => {
        assert.equal(observed.error, undefined);
        assert.equal(observed.rows[0].value, "retained private data 🦀");
      },
      10000,
    );
    entry.retained = retained.rows[0].value;
    await sql.end({ timeout: 2 });
    sql = undefined;
    second.child.stdin.end();
    entry.newOwner = await finished(second);
    assert.equal(entry.newOwner.code, 0, second.log());
    entry.passed = true;
  } catch (error) {
    entry.failure = String(error);
    throw error;
  } finally {
    if (
      paused &&
      first?.child.exitCode === null &&
      first.child.signalCode === null
    )
      first.child.kill("SIGCONT");
    first?.child.stdin.end();
    second?.child.stdin.end();
    await sql?.end({ timeout: 2 });
    await stop(bin, privateRoot);
    for (const owner of [first, second])
      if (owner?.child.exitCode === null && owner.child.signalCode === null) {
        try {
          await finished(owner);
        } catch {
          owner.child.kill("SIGKILL");
          await owner.completion;
        }
      }
    entry.ownerLogs = [first?.log(), second?.log()];
  }
}
