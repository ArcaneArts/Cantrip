import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment } from "./process.mjs";

export async function nativeExportTls({
  executable,
  url,
  root,
  binary,
  postgres,
  accepted,
  ssl,
}) {
  const connection = new URL(url);
  const name = connection.searchParams.get("application_name") + "_export";
  connection.searchParams.set("application_name", name);
  const destination = path.join(root, name + ".sql");
  const controlUrl = new URL(url);
  controlUrl.searchParams.set("sslmode", "disable");
  const locker = accepted
    ? postgres(controlUrl.href, { max: 1, ssl: false })
    : undefined;
  const inspector = accepted
    ? postgres(controlUrl.href, { max: 1, ssl: false })
    : undefined;
  let held = false,
    child,
    completion,
    failure;
  const result = { accepted };
  try {
    let lockerPid;
    if (accepted) {
      await locker`BEGIN`;
      held = true;
      [{ pid: lockerPid }] = await locker`SELECT pg_backend_pid() AS pid`;
      await locker`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
    }
    child = spawn(
      executable,
      [
        "--database",
        "postgres",
        "--database-url",
        connection.href,
        "--migrate-only",
        "--export-sql",
        destination,
        "--pg-dump-path",
        process.env.CANTRIP_TEST_PG_DUMP_PATH ?? binary("pg_dump"),
      ],
      {
        cwd: repositoryRoot,
        env: fixtureEnvironment(path.join(root, name)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      exited;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve((exited = { code, signal, stdout, stderr })),
      );
    });
    completion.catch(() => {});
    if (accepted) {
      const deadline = Date.now() + 30000;
      for (;;) {
        const waiting =
          await inspector`SELECT a.pid,a.query,s.ssl,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.application_name=${name} AND a.wait_event_type='Lock'`;
        const witness = waiting.find((row) => row.blockers.includes(lockerPid));
        if (witness) {
          assert.equal(
            witness.ssl,
            ssl,
            "actual blocked pg_dump backend uses the reference TLS mode",
          );
          assert.match(witness.query, /^LOCK TABLE/);
          result.witness = witness;
          break;
        }
        assert.equal(exited, undefined, JSON.stringify(exited));
        assert.ok(
          Date.now() < deadline,
          "actual pg_dump must reach the held relation lock",
        );
        await delay(20);
      }
      await locker`ROLLBACK`;
      held = false;
    }
    result.command = await completion;
    assert.equal(result.command.code === 0, accepted, result.command.stderr);
    if (accepted) {
      const sql = await readFile(destination);
      const records = stdout.split(/\r?\n/).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const receipt = records.find(
        (record) => record.event === "database.export.completed",
      )?.receipt;
      assert.ok(receipt);
      assert.equal(receipt.bytes, sql.length);
      assert.equal(
        receipt.sha256,
        createHash("sha256").update(sql).digest("hex"),
      );
      result.receipt = receipt;
    } else await assert.rejects(readFile(destination), { code: "ENOENT" });
  } catch (error) {
    failure = error;
  } finally {
    if (held) await locker`ROLLBACK`;
    if (failure && child?.exitCode === null && child?.signalCode === null)
      child.kill("SIGTERM");
    if (completion)
      await completion.catch((error) => {
        failure ??= error;
      });
    await locker?.end({ timeout: 5 });
    await inspector?.end({ timeout: 5 });
  }
  if (failure) throw failure;
  return result;
}
