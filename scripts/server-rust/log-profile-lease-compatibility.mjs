// Block a real log write while a real profile activation waits for its lease.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "./postgres-fixture.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    probe: { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-log-profile-lease-"));
console.error(JSON.stringify({ event: "log-profile-lease.created", root }));
const report = { root };
let pg, failure, server, probe, witness, reader, closing, probeCompletion;
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  const active = path.join(root, "active"),
    prepared = path.join(root, "prepared"),
    logs = path.join(active, "logs");
  await mkdir(logs, { recursive: true });
  await mkdir(prepared);
  await writeFile(path.join(active, "sentinel"), "old-profile-preserved");
  await writeFile(path.join(prepared, "sentinel"), "new-profile-published");
  const filename = `server-${new Date().toISOString().slice(0, 10)}.part-0001.jsonl`;
  await promisify(execFile)("mkfifo", ["-m", "600", path.join(logs, filename)]);
  const env = {
    ...fixtureEnvironment(active),
    DATABASE_URL: await pg.database(),
  };
  server = await startServer(
    values.server,
    ["--database", "postgres", "--port", "0", "--shutdown-on-stdin-close"],
    { env },
  );
  report.fifo = path.join(logs, filename);
  probe = spawn(values.probe, [prepared, active, "completed"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  report.probeStderr = "";
  probe.stderr.on("data", (data) => {
    report.probeStderr += data;
  });
  probeCompletion = new Promise((yes, no) => {
    probe.once("error", no);
    probe.once("close", (code, signal) => yes({ code, signal }));
  });
  createInterface({ input: probe.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.event === "profile.activation.paused") witness = event;
    } catch {}
  });
  closing = server.close({ shutdownTimeoutMs: 15000 });
  const deadline = Date.now() + 10000;
  while (
    !server.events.some(
      (event) =>
        event.event === "server.shutdown.stage" &&
        event.stage === "database" &&
        event.phase === "completed",
    )
  ) {
    assert.equal(
      server.child.exitCode,
      null,
      "Server remains alive with real archive I/O blocked",
    );
    assert.ok(Date.now() < deadline, "Database must drain before the archive");
    await delay(10);
  }
  await delay(500);
  report.activationWhileArchiveBlocked = witness ?? null;
  assert.equal(server.child.exitCode, null);
  // This actual open releases the pending FIFO write; no archive mock or
  // shortened production shutdown deadline is involved.
  reader = await open(
    path.join(logs, filename),
    constants.O_RDWR | constants.O_NONBLOCK,
  ).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    const journalName = (await readdir(root)).find(
      (name) =>
        name.startsWith(".cantrip-activation-") && name.endsWith(".json"),
    );
    const journal = JSON.parse(
      await readFile(path.join(root, journalName), "utf8"),
    );
    report.fifo = path.join(journal.backup, "logs", filename);
    return open(report.fifo, constants.O_RDWR | constants.O_NONBLOCK);
  });
  report.serverClose = await closing;
  report.serverExit = {
    code: server.child.exitCode,
    signal: server.child.signalCode,
  };
  report.serverDiagnostics = server.diagnostics();
  const chunks = [];
  for (;;) {
    const buffer = Buffer.alloc(4096);
    try {
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
    } catch (error) {
      if (error.code === "EAGAIN") break;
      throw error;
    }
  }
  report.capturedPipeText = Buffer.concat(chunks).toString("utf8");
  const after = Date.now() + 10000;
  while (!witness) {
    assert.ok(Date.now() < after, "Activation must finish after archive drain");
    await delay(10);
  }
  report.activationAfterDrain = witness;
  const journalName = (await readdir(root)).find(
    (name) => name.startsWith(".cantrip-activation-") && name.endsWith(".json"),
  );
  const journal = JSON.parse(
    await readFile(path.join(root, journalName), "utf8"),
  );
  report.fifo = path.join(journal.backup, "logs", filename);
  const records = report.capturedPipeText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter(
      (record) => record.context?.event === "server.shutdown.completed",
    ).length,
    1,
  );
  assert.equal(
    report.activationWhileArchiveBlocked,
    null,
    "Profile activation must wait for final archive I/O before moving the profile",
  );
  report.archiveDrainHeldProfileLease = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await reader?.close();
  if (probe && probe.exitCode === null && probe.signalCode === null)
    probe.kill("SIGKILL");
  if (probeCompletion) report.probeExit = await probeCompletion;
  if (server) {
    if (server.child.exitCode === null && server.child.signalCode === null)
      server.child.kill("SIGKILL");
    if (closing) await closing.catch(() => {});
    else await server.close();
  }
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, root }));
