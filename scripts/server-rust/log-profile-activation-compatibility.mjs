// Exercise actual interrupted profile renames before the native logging startup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { postgresFixture } from "./postgres-fixture.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    probe: { type: "string" },
    step: { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-log-profile-activation-"),
);
console.error(
  JSON.stringify({ event: "log-profile-activation.created", root }),
);
const report = { root, cases: [] };
let pg, failure;
async function interrupt(prepared, active, step) {
  const child = spawn(values.probe, [prepared, active, step], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const completion = new Promise((yes, no) => {
    child.once("error", no);
    child.once("close", (code, signal) => yes({ code, signal }));
  });
  let timer, witness;
  try {
    await new Promise((yes, no) => {
      timer = setTimeout(
        () => no(new Error("No actual activation rename witness: " + stderr)),
        30000,
      );
      completion.then(
        (result) =>
          no(
            new Error(
              "Activation probe exited: " + JSON.stringify(result) + stderr,
            ),
          ),
        no,
      );
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (
            event.event === "profile.activation.paused" &&
            event.step === step
          ) {
            witness = event;
            yes();
          }
        } catch {}
      });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await completion;
  }
  return { witness, exit: await completion, stderr };
}
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const step of values.step
    ? [values.step]
    : ["prepared-moved", "previous-retained", "new-published", "completed"]) {
    const parent = path.join(root, step),
      active = path.join(parent, "active"),
      prepared = path.join(parent, "prepared");
    await mkdir(active, { recursive: true });
    await mkdir(prepared);
    await writeFile(path.join(active, "sentinel"), "old-profile-preserved");
    await writeFile(path.join(prepared, "sentinel"), "new-profile-published");
    const interruption = await interrupt(prepared, active, step);
    const result = { step, interruption };
    report.cases.push(result);
    const env = {
      ...fixtureEnvironment(active),
      DATABASE_URL: await pg.database(),
    };
    const start = () =>
      startServer(
        values.server,
        ["--database", "postgres", "--port", "0", "--shutdown-on-stdin-close"],
        { env },
      );
    const request = async (server, route, options = {}) => {
      const response = await fetch(server.origin + route, {
        ...options,
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
        },
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    let server = await start();
    try {
      result.identity = (await request(server, "/api/bootstrap")).server.id;
      await request(server, "/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: "light" }),
      });
    } finally {
      result.firstClose = await server.close();
      result.firstExit = {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
    }
    const directory = path.join(active, "logs"),
      records = [];
    for (const file of (await readdir(directory)).filter((name) =>
      name.endsWith(".jsonl"),
    ))
      records.push(
        ...(await readFile(path.join(directory, file), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    for (const event of [
      "server.startup.started",
      "server.startup.database-ready",
      "server.startup.completed",
      "server.shutdown.started",
      "server.shutdown.completed",
    ])
      assert.equal(
        records.filter((record) => record.context?.event === event).length,
        1,
        `${step}: ${event}`,
      );
    result.archivedLifecycle = true;
    assert.equal(
      await readFile(path.join(active, "sentinel"), "utf8"),
      "new-profile-published",
    );
    const journalName = (await readdir(parent)).find(
      (name) =>
        name.startsWith(".cantrip-activation-") && name.endsWith(".json"),
    );
    const journal = JSON.parse(
      await readFile(path.join(parent, journalName), "utf8"),
    );
    assert.equal(
      await readFile(path.join(journal.backup, "sentinel"), "utf8"),
      "old-profile-preserved",
    );
    result.backupPreserved = true;
    server = await start();
    try {
      assert.equal(
        (await request(server, "/api/bootstrap")).server.id,
        result.identity,
      );
      assert.equal(
        (await request(server, "/api/settings")).preferences.theme,
        "light",
      );
    } finally {
      result.secondClose = await server.close();
      result.secondExit = {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
    }
    result.acceptedWriteRetained = true;
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, root, cases: report.cases.length }));
