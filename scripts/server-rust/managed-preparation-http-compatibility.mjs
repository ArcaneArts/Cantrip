// Actual authenticated HTTP/Live and the unchanged worker command transport.
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
  settingsWorker,
  settingsProject,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { prepareManagedConsoleState } from "../../cantrip_worker/src/managed-console-state.ts";
import { openTerminalPrivateState } from "../../cantrip_worker/src/terminal-private-state.ts";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-preparation-http-"));
const report = {
  suite: "managed-preparation-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, active, failure;
async function wait(read, predicate, label) {
  const until = Date.now() + 20000;
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
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, proofs: [], commands: [], identityReads: 0 };
      outputs.push(result);
      const attachments = new Map();
      let failConsole = false,
        protectedState;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
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
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('preparation-http-provider',${literal(owner)},'Controlled preparation','ollama','http://localhost:11434')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('preparation-http-model',${literal(owner)},'Controlled preparation')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('preparation-http-route','preparation-http-model','preparation-http-provider','controlled',0,true)",
          `UPDATE chats SET model_id='preparation-http-model' WHERE id=${literal(settingsChat)}`,
          `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(settingsChat)}`,
        ],
        onCommand: async (command, emit, { encryption, owner, serverId }) => {
          if (
            ![
              "chat.thread.ensure",
              "terminal.prepare-state",
              "terminal.open",
              "terminal.detach",
              "worker-link.identity.resolve",
            ].includes(command.type)
          )
            return undefined;
          result.commands.push(command.type);
          if (command.type === "chat.thread.ensure")
            return {
              threadId: command.threadId ?? "prepared-http-native-thread",
            };
          if (command.type === "terminal.prepare-state") {
            protectedState = await prepareManagedConsoleState(
              command.terminalId,
              command.serverId,
              encryption,
            );
            return protectedState;
          }
          if (command.type === "terminal.open") {
            const state = await openTerminalPrivateState({
              ...command,
              service: encryption,
            });
            assert.equal(state.serviceCommand, "");
            assert.equal(
              command.launch.threadId,
              "prepared-http-native-thread",
            );
            if (failConsole) throw new Error("Controlled HTTP console failure");
            const finished = new Promise((resolve) =>
              attachments.set(command.attachmentId, () =>
                resolve({ status: "detached" }),
              ),
            );
            await emit({
              type: "terminal.ready",
              terminalId: command.terminalId,
            });
            return finished;
          }
          if (command.type === "terminal.detach") {
            attachments.get(command.attachmentId)?.();
            return { status: "detached" };
          }
          result.identityReads++;
          return {
            serverId,
            ownerId: owner,
            workerId: settingsWorker,
            workerProcessGeneration: "preparation-http-process",
          };
        },
      }));
      const route = `/api/chats/${settingsChat}/preparation`;
      const read = async () =>
        (await h.visit("read preparation", "GET", route)).preparation;
      await h.visit("missing chat", "GET", "/api/chats/missing/preparation", {
        status: 404,
      });
      await h.visit(
        "missing request",
        "POST",
        "/api/chats/missing/preparation",
        { status: 404, json: {} },
      );
      assert.equal(await read(), null);
      await h.visit("malformed JSON", "POST", route, {
        status: 400,
        raw: "{",
        headers: { "content-type": "application/json" },
      });
      const requested = (
        await h.visit("request preparation", "POST", route, {
          status: 202,
          json: { ignored: true },
        })
      ).preparation;
      const ready = await wait(
        read,
        (s) => s?.phase === "ready",
        "real worker preparation ready",
      );
      assert.equal(ready.terminalId, requested.terminalId);
      const terminals = await h.visit(
        "linked terminal",
        "GET",
        `/api/projects/${settingsProject}/terminals`,
      );
      const console = terminals.find((t) => t.linkedChatId === settingsChat);
      assert.equal(console.id, ready.terminalId);
      assert.equal(console.status, "running");
      assert.deepEqual(console.stateProtection, protectedState.stateProtection);
      assert.deepEqual(console.titleProtection, protectedState.titleProtection);
      result.proofs.push(
        "real encrypted worker state and durable console identity",
      );
      if (profile === "accounts") {
        await h.visit("foreign get", "GET", route, {
          client: "other",
          status: 404,
        });
        await h.visit("foreign request", "POST", route, {
          client: "other",
          status: 404,
          json: {},
        });
        result.proofs.push("foreign owner cannot observe or prepare chat");
      }
      const notification = {
        type: "terminal.runtime.observed",
        terminalId: ready.terminalId,
        managedPreparationGeneration: ready.generation,
        status: "exited",
        exitCode: 1,
        signal: null,
      };
      let before = result.identityReads;
      assert.equal(
        h.worker.sendNotification({
          ...notification,
          workerProcessGeneration: "superseded-process",
        }),
        true,
      );
      await wait(
        async () => result.identityReads,
        (n) => n > before,
        "identity resolved for stale process",
      );
      assert.equal((await read()).phase, "ready");
      assert.equal(
        h.worker.sendNotification({
          ...notification,
          workerProcessGeneration: "preparation-http-process",
        }),
        true,
      );
      const exited = await wait(
        read,
        (s) => s?.phase === "failed",
        "authenticated detached exit",
      );
      assert.equal(exited.failedPhase, "console");
      const exitedTerminals = await h.visit(
        "exited terminal",
        "GET",
        `/api/projects/${settingsProject}/terminals`,
      );
      assert.equal(
        exitedTerminals.find((t) => t.id === ready.terminalId).status,
        "exited",
      );
      result.proofs.push(
        "process identity and preparation generation fence detached exit",
      );
      await h.visit("retry preparation", "POST", route, {
        status: 202,
        json: {},
      });
      const retried = await wait(
        read,
        (s) => s?.phase === "ready",
        "retry after exit",
      );
      assert.equal(retried.terminalId, ready.terminalId);
      assert.notEqual(retried.generation, ready.generation);
      before = result.identityReads;
      assert.equal(
        h.worker.sendNotification({
          ...notification,
          workerProcessGeneration: "preparation-http-process",
        }),
        true,
      );
      await wait(
        async () => result.identityReads,
        (n) => n > before,
        "identity resolved for stale preparation",
      );
      assert.equal((await read()).generation, retried.generation);
      assert.equal((await read()).phase, "ready");
      result.proofs.push("late old exit cannot overwrite a successful retry");
      failConsole = true;
      await h.visit("console failure", "POST", route, {
        status: 202,
        json: {},
      });
      const failed = await wait(
        read,
        (s) => s?.phase === "failed",
        "console failure",
      );
      assert.equal(failed.failedPhase, "console");
      assert.equal(result.commands.includes("terminal.input"), false);
      result.proofs.push(
        "console failure remains separate from prepared native thread",
      );
      const events = await wait(
        async () =>
          h.live.history.filter(
            (f) => f.type === "event" && f.resource === "chat-preparation",
          ),
        (events) => events.length >= 10,
        "committed preparation Live events",
      );
      assert.equal(events.length, 10);
      for (const event of events) {
        assert.deepEqual(event.scope, { kind: "chat", chatId: settingsChat });
        assert.equal(event.action, "invalidated");
        assert.equal(event.payload, null);
      }
      result.livePreparations = events.map((event) => ({
        scope: event.scope,
        entityId: event.entityId,
        action: event.action,
      }));
      result.proofs.push(
        "exact committed preparation invalidations reach the existing Live client",
      );
      await h.close();
      active = null;
    }
    assert.deepEqual(
      outputs[1].proofs,
      outputs[0].proofs,
      "Both actual runtimes must complete the same product assertions",
    );
  }
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  try {
    await active?.close();
    await pg?.close();
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      "Preparation HTTP cleanup failed",
    );
  }
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
    profiles: report.profiles.length,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
