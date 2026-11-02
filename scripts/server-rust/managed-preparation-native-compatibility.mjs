import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsTree,
} from "./native-settings-http-fixture.mjs";
import { nativePreparationWorker } from "./managed-preparation-native-worker.mjs";
import { literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  binary = option("--binary") ?? process.env.CANTRIP_CODEX_TEST_BINARY;
assert.ok(binary, "Supply the actual Cantrip Codex runtime with --binary");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-preparation-native-"));
const report = {
  suite: "real-native-preparation",
  databaseMode,
  binary,
  completeReplacement: false,
  runtimes: [],
};
let pg, active, native, failure;
async function wait(read, predicate, label) {
  const until = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < until);
  assert.ok(predicate(value), `${label}: ${JSON.stringify(value)}`);
}
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const result = { kind, proofs: [] };
    report.runtimes.push(result);
    native = await nativePreparationWorker({
      root: path.join(root, kind, "actual-worker"),
      binary,
    });
    const h = (active = await settingsHttpFixture({
      kind,
      profile: "none",
      root,
      executable,
      repositoryExecutable,
      databaseMode,
      passwordHash,
      url:
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined,
      result: { observations: [], snapshotProofs: 0, defaultsProofs: 0 },
      configure: (owner) => [
        `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('preparation-native-provider',${literal(owner)},'Actual native fixture','openai-compatible',${literal(native.providerUrl)})`,
        `INSERT INTO model_profiles(id,owner_id,name) VALUES('preparation-native-model',${literal(owner)},'Actual native fixture')`,
        "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('preparation-native-route','preparation-native-model','preparation-native-provider','controlled',0,true)",
        `UPDATE chats SET model_id='preparation-native-model' WHERE id=${literal(settingsChat)}`,
        `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(settingsChat)}`,
        `UPDATE project_worktrees SET absolute_path=${literal(native.cwd)},display_path=${literal(native.cwd)} WHERE id=${literal(settingsTree)}`,
      ],
      onCommand: (...args) => native.handle(...args),
    }));
    native.attach(h);
    result.responses = native.responses;
    result.failures = native.failures;
    const route = `/api/chats/${settingsChat}/preparation`,
      read = async () =>
        (await h.visit("native preparation status", "GET", route)).preparation;
    await h.visit("native request", "POST", route, { status: 202, json: {} });
    const ready = await wait(
      read,
      (v) => v?.phase === "ready",
      "actual native CLI preparation",
    );
    await wait(
      async () => native.resumes(),
      (v) => v === 1,
      "first gateway native resume settled",
    );
    assert.equal(native.isLive(ready.terminalId), true);
    assert.deepEqual((await native.history()).thread.turns, []);
    assert.deepEqual(native.providerRequests, []);
    result.proofs.push(
      "actual PTY resumes through authenticated native command admission and settlement",
    );
    native.closeConsole(ready.terminalId);
    const exited = await wait(
      read,
      (v) => v?.phase === "failed",
      "actual PTY exit notification",
    );
    assert.equal(exited.failedPhase, "console");
    assert.deepEqual((await native.history()).thread.turns, []);
    result.proofs.push(
      "actual detached CLI exit persists failed console without ending the native conversation",
    );
    await h.visit("native retry", "POST", route, { status: 202, json: {} });
    const retried = await wait(
      read,
      (v) => v?.phase === "ready",
      "actual CLI retry",
    );
    await wait(
      async () => native.resumes(),
      (v) => v === 2,
      "second gateway native resume settled",
    );
    assert.equal(retried.terminalId, ready.terminalId);
    assert.notEqual(retried.generation, ready.generation);
    assert.equal(native.isLive(retried.terminalId), true);
    assert.deepEqual((await native.history()).thread.turns, []);
    assert.deepEqual(native.providerRequests, []);
    assert.equal(native.commands.includes("terminal.input"), false);
    result.proofs.push(
      "retry retains console/thread and performs no inference or synthetic terminal input",
    );
    result.commands = native.commands;
    result.nativeResumes = native.resumes();
    await native.close();
    native = null;
    await h.close();
    active = null;
  }
  assert.deepEqual(report.runtimes[1].proofs, report.runtimes[0].proofs);
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const errors = [];
  for (const close of [
    () => native?.close(),
    () => active?.close(),
    () => pg?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Actual native preparation cleanup failed",
    );
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    runtimes: report.runtimes.length,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
