// Real HTTP, existing worker client/transport, and authenticated endpoint crypto.
// The controlled worker advances the real server; native file transfer is a
// separate acceptance test and is not claimed by this suite.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { NativeRuntimeHandoffClient } from "../../cantrip_worker/src/native-runtime-handoff-client.ts";
import { prepareManagedConsoleState } from "../../cantrip_worker/src/managed-console-state.ts";
import { openTerminalPrivateState } from "../../cantrip_worker/src/terminal-private-state.ts";
import {
  openNativeSettingsSnapshot,
  protectNativeSettingsSnapshot,
} from "../../cantrip_worker/src/native-settings-content.ts";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-handoff-http-"));
const report = {
  suite: "native-handoff-http",
  databaseMode,
  completeReplacement: false,
  nativeFileTransfer: false,
  profiles: [],
};
const route = `/api/chats/${settingsChat}/runtime-handoffs`;
let pg, active, failure;
let releasePending = () => {};
async function wait(read, predicate, label) {
  const deadline = Date.now() + 20000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.ok(predicate(value), `${label}: ${JSON.stringify(value)}`);
}
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        proofs: [],
        commands: [],
        observations: [],
        workerHttp: [],
        preparationCommands: [],
        snapshotProofs: 0,
        defaultsProofs: 0,
      };
      outputs.push(result);
      let h,
        client,
        privateSettings,
        mode = "hold",
        generation = 0;
      const held = [];
      const attachments = new Map();
      releasePending = () => {
        for (const command of held) command.resolve();
      };
      const operation = (index) =>
        `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
      const base = (id) => ({
        chatId: settingsChat,
        operationId: operation(id),
      });
      async function prepared(state) {
        const runtimeGeneration = `http-handoff-runtime-${++generation}`;
        return {
          threadId: "thread",
          runtimeGeneration,
          reasoningEffort: "high",
          snapshot: await protectNativeSettingsSnapshot({
            service: h.encryption,
            context: {
              chatId: settingsChat,
              workerId: settingsWorker,
              threadId: "thread",
              runtimeGeneration,
              settingsVersion: { epoch: `core-${generation}`, revision: "0" },
            },
            settings: {
              ...privateSettings,
              settingsVersion: { epoch: `core-${generation}`, revision: "0" },
            },
            modelAttribution: {
              status: "resolved",
              workerId: settingsWorker,
              providerId:
                state.targetModelRouteId === "http-handoff-source"
                  ? "http-handoff-source-provider"
                  : "http-handoff-destination-provider",
              providerAccountId: null,
              modelId:
                state.targetModelRouteId === "http-handoff-source"
                  ? "http-handoff-source-model"
                  : "http-handoff-destination-model",
              routeId: state.targetModelRouteId,
            },
          }),
        };
      }
      h = active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        passwordHash,
        result,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        configure: (owner, scope) => {
          scope.modelRouteId = "http-handoff-source";
          return [
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('http-handoff-source-provider',${literal(owner)},'Controlled source','openai-compatible','http://localhost:8080'),('http-handoff-destination-provider',${literal(owner)},'Controlled destination','openai-compatible','http://localhost:8081')`,
            `INSERT INTO model_profiles(id,owner_id,name) VALUES('http-handoff-source-model',${literal(owner)},'Source'),('http-handoff-destination-model',${literal(owner)},'Destination')`,
            "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('http-handoff-source','http-handoff-source-model','http-handoff-source-provider','source',0,true),('http-handoff-destination','http-handoff-destination-model','http-handoff-destination-provider','destination',0,true)",
            "INSERT INTO provider_models(id,provider_id,native_model_id,display_name,supports_reasoning,supported_reasoning_efforts,metadata_source) SELECT id||'-catalog',provider_id,model_name,model_name,true,'[{\"effort\":\"high\",\"description\":\"High\"}]'::jsonb,'manual' FROM model_routes WHERE id IN ('http-handoff-source','http-handoff-destination')",
            "UPDATE model_routes SET provider_model_id=id||'-catalog' WHERE id IN ('http-handoff-source','http-handoff-destination')",
            `UPDATE chats SET model_id='http-handoff-source-model' WHERE id=${literal(settingsChat)}`,
            `UPDATE chat_runtime_sessions SET model_route_id='http-handoff-source' WHERE chat_id=${literal(settingsChat)}`,
          ];
        },
        onCommand: async (command, emit, { encryption, serverId }) => {
          if (
            [
              "chat.thread.ensure",
              "terminal.prepare-state",
              "terminal.open",
              "terminal.detach",
            ].includes(command.type)
          ) {
            assert.equal(
              (await client.request({ ...base(4), action: "read" })).phase,
              "completed",
              "reconnected preparation must join actual handoff recovery",
            );
            result.preparationCommands.push(command.type);
            if (command.type === "chat.thread.ensure")
              return { threadId: "thread" };
            if (command.type === "terminal.prepare-state")
              return prepareManagedConsoleState(
                command.terminalId,
                serverId,
                encryption,
              );
            if (command.type === "terminal.open") {
              const opened = await openTerminalPrivateState({
                ...command,
                service: encryption,
              });
              assert.equal(opened.serviceCommand, "");
              assert.equal(
                command.launch.model.routeId,
                "http-handoff-destination",
              );
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
            attachments.get(command.attachmentId)?.();
            return { status: "detached" };
          }
          if (command.type !== "chat.runtime.handoff") return undefined;
          result.commands.push({ ...command });
          const advance = mode === "complete" || mode === "recover-held";
          if (
            command.intent !== "cancel" &&
            ["hold", "recover-held"].includes(mode)
          ) {
            await new Promise((resolve) =>
              held.push({ operationId: command.operationId, resolve }),
            );
          }
          if (command.intent === "cancel") {
            await client.request({
              chatId: command.chatId,
              operationId: command.operationId,
              action: "finish",
              outcome: "cancelled",
            });
          } else if (mode === "fail") {
            throw new Error(
              "Controlled private worker diagnostic must not escape",
            );
          } else if (advance) {
            const input = {
              chatId: command.chatId,
              operationId: command.operationId,
            };
            const state = await client.request({ ...input, action: "read" });
            const configuration = await client.configuration({
              ...input,
              side: "destination",
            });
            assert.equal(
              configuration.configuration.model.routeId,
              state.targetModelRouteId,
            );
            await client.request({
              ...input,
              action: "prepared",
              expectedPreparedRuntimeGeneration: null,
              prepared: await prepared(state),
            });
            await client.request({ ...input, action: "commit" });
            await client.request({
              ...input,
              action: "finish",
              outcome: "completed",
            });
          }
          return null;
        },
      });
      client = new NativeRuntimeHandoffClient({
        serverUrl: h.fixture.server.origin,
        workerId: settingsWorker,
        token: () => h.credential,
        fetch: async (url, options) => {
          const input = JSON.parse(options.body);
          const step = {
            operationId: input.operationId,
            action: input.action ?? "configuration",
            side: input.side,
          };
          result.workerHttp.push({ ...step, phase: "sent" });
          const response = await fetch(url, options);
          result.workerHttp.push({
            ...step,
            phase: "received",
            status: response.status,
          });
          return response;
        },
      });
      const sourceSnapshot = await h.snapshot();
      privateSettings = await openNativeSettingsSnapshot({
        service: h.encryption,
        context: sourceSnapshot.context,
        snapshot: sourceSnapshot,
      });
      const auth = {
        client: "worker",
        headers: { authorization: `Bearer ${h.credential}` },
      };
      const internal = (name, input, status = 200, extra = {}) =>
        h.visit(name, "POST", "/api/internal/native-runtime-handoffs", {
          ...auth,
          json: { workerId: settingsWorker, ...input },
          status,
          ...extra,
        });
      const pollClient = new NativeRuntimeHandoffClient({
        serverUrl: h.fixture.server.origin,
        workerId: settingsWorker,
        token: () => h.credential,
      });
      const state = (id) => pollClient.request({ ...base(id), action: "read" });
      const readPreparation = async () => {
        const response = await fetch(
          `${h.fixture.server.origin}/api/chats/${settingsChat}/preparation`,
          {
            headers: {
              cookie: [...h.fixture.client().cookies]
                .map(([key, value]) => `${key}=${value}`)
                .join("; "),
            },
          },
        );
        assert.equal(response.status, 200);
        return (await response.json()).preparation;
      };
      const release = (id) => {
        const hold = held.find((item) => item.operationId === operation(id));
        assert.ok(hold, "actual held worker command");
        hold.resolve();
      };
      const invalidations = () =>
        h.live.history.filter(
          (frame) =>
            frame.type === "event" &&
            frame.resource === "chat" &&
            frame.scope.kind === "chat" &&
            frame.scope.chatId === settingsChat,
        );
      async function begin(id, target) {
        const binding = (
          await h.visit(
            `current binding ${id}`,
            "GET",
            `/api/chats/${settingsChat}/native-settings`,
          )
        ).binding;
        return h.visit(`begin transfer ${id}`, "POST", route, {
          status: 202,
          json: {
            operationId: operation(id),
            bindingId: binding.bindingId,
            targetModelRouteId: target,
            targetProviderAccountId: null,
          },
        });
      }
      await h.visit(
        "missing inventory",
        "GET",
        "/api/chats/missing/runtime-handoffs",
        { status: 404 },
      );
      await h.visit("missing operation", "GET", `${route}/${operation(999)}`, {
        status: 404,
      });
      await h.visit("malformed begin JSON", "POST", route, {
        status: 400,
        raw: "{",
        headers: { "content-type": "application/json" },
      });
      await h.visit("invalid begin schema", "POST", route, {
        status: 400,
        json: {},
      });
      await internal("invalid internal schema", {}, 400);
      await internal(
        "unauthenticated worker",
        { ...base(1), action: "read" },
        401,
        { headers: {} },
      );
      await internal(
        "credential cannot impersonate another worker",
        { ...base(1), workerId: "another-worker", action: "read" },
        401,
      );
      if (profile === "accounts") {
        await h.visit("foreign inventory", "GET", route, {
          client: "other",
          status: 404,
        });
        await h.visit("foreign operation", "GET", `${route}/${operation(1)}`, {
          client: "other",
          status: 404,
        });
      }
      await h.visit(
        "bind source through actual worker",
        "POST",
        `/api/chats/${settingsChat}/native-settings/refresh`,
        { json: {} },
      );
      const inventory = await h.visit("initial inventory", "GET", route);
      assert.equal(inventory.latest, null);
      assert.equal(inventory.binding.modelRouteId, "http-handoff-source");
      await h.visit(
        "same provider account cannot be transferred to itself",
        "POST",
        route,
        {
          status: 409,
          json: {
            operationId: operation(999),
            bindingId: inventory.binding.bindingId,
            targetModelRouteId: "http-handoff-source",
            targetProviderAccountId: null,
          },
        },
      );
      await wait(
        async () => invalidations(),
        (events) => events.length === 1,
        "source refresh invalidation",
      );
      const initialEvents = invalidations().length;
      const first = await begin(1, "http-handoff-destination");
      assert.equal(first.phase, "preparing");
      await wait(
        async () => held.length,
        (count) => count === 1,
        "real worker receives handoff command",
      );
      await h.visit(
        "pending retry joins existing worker operation",
        "POST",
        `${route}/${operation(1)}/retry`,
        { status: 202 },
      );
      assert.equal(
        (
          await internal("read owned reservation", {
            ...base(1),
            action: "read",
          })
        ).phase,
        "preparing",
      );
      await internal(
        "operation is scoped to chat",
        { ...base(1), chatId: "missing", action: "read" },
        404,
      );
      await internal(
        "commit cannot skip preparation",
        { ...base(1), action: "commit" },
        409,
      );
      for (const side of ["source", "destination"]) {
        const config = await client.configuration({ ...base(1), side });
        assert.equal(config.configuration.threadId, "thread");
        assert.equal(
          config.configuration.model.routeId,
          `http-handoff-${side}`,
        );
        await h.visit(
          `configuration ${side}`,
          "POST",
          "/api/internal/native-runtime-handoffs/configuration",
          { ...auth, json: { ...base(1), workerId: settingsWorker, side } },
        );
      }
      const destination = await prepared(first);
      await internal("prepared destination", {
        ...base(1),
        action: "prepared",
        expectedPreparedRuntimeGeneration: null,
        prepared: destination,
      });
      const committed = await internal("commit destination", {
        ...base(1),
        action: "commit",
      });
      assert.equal(committed.phase, "committed");
      assert.equal(committed.binding.modelRouteId, "http-handoff-destination");
      assert.notEqual(committed.binding.bindingId, first.source.bindingId);
      assert.equal(committed.binding.threadId, first.source.threadId);
      await internal("old source cannot be configured", {
        ...base(1),
        action: "read",
      });
      await h.visit(
        "committed source configuration refused",
        "POST",
        "/api/internal/native-runtime-handoffs/configuration",
        {
          ...auth,
          status: 409,
          json: { ...base(1), workerId: settingsWorker, side: "source" },
        },
      );
      const completed = await internal("acknowledge completed destination", {
        ...base(1),
        action: "finish",
        outcome: "completed",
      });
      assert.equal(completed.phase, "completed");
      release(1);
      await wait(
        async () => invalidations(),
        (events) => events.length === initialEvents + 5,
        "all five handoff invalidations",
      );
      await h.visit("completed transfer", "GET", `${route}/${operation(1)}`);
      assert.equal(
        result.commands.filter(
          (command) => command.operationId === operation(1),
        ).length,
        1,
      );
      result.proofs.push(
        "actual authenticated worker configuration, encrypted preparation, atomic binding transfer and separate durable acknowledgement",
      );
      mode = "fail";
      await begin(2, "http-handoff-source");
      const failed = await wait(
        () => state(2),
        (value) => value.errorCode === "handoff-worker-unavailable",
        "worker failure persisted as public code",
      );
      assert.equal(failed.phase, "preparing");
      await h.visit("failed transfer", "GET", `${route}/${operation(2)}`);
      mode = "complete";
      await h.visit(
        "retry actual worker transfer",
        "POST",
        `${route}/${operation(2)}/retry`,
        { status: 202 },
      );
      const retried = await wait(
        () => state(2),
        (value) => value.phase === "completed",
        "retry completed through real HTTP worker client",
      );
      assert.equal(retried.binding.modelRouteId, "http-handoff-source");
      await h.visit("retried transfer", "GET", `${route}/${operation(2)}`);
      result.proofs.push(
        "worker transport failure is durable, retry advances the same operation and does not leak private errors",
      );
      mode = "hold";
      await begin(3, "http-handoff-destination");
      await wait(
        async () => held.some((item) => item.operationId === operation(3)),
        Boolean,
        "cancellable worker command",
      );
      await h.visit(
        "cancel actual worker transfer",
        "POST",
        `${route}/${operation(3)}/cancel`,
        { status: 202 },
      );
      const cancelled = await wait(
        () => state(3),
        (value) => value.phase === "cancelled",
        "worker acknowledges cancellation",
      );
      assert.equal(cancelled.binding.modelRouteId, "http-handoff-source");
      release(3);
      await h.visit("cancelled transfer", "GET", `${route}/${operation(3)}`);
      await h.visit(
        "invalid unused retry JSON",
        "POST",
        `${route}/${operation(3)}/retry`,
        {
          status: 400,
          raw: "{",
          headers: { "content-type": "application/json" },
        },
      );
      const terminalCommands = result.commands.length;
      await h.visit(
        "terminal retry is idempotent",
        "POST",
        `${route}/${operation(3)}/retry`,
        { status: 202 },
      );
      assert.equal(result.commands.length, terminalCommands);
      result.proofs.push(
        "cancellation uses a separate worker intent, preserves source binding and terminal retry does not dispatch",
      );
      // Ensure the client observes every committed publication before comparing
      // events. The actual command completion is the final invalidation.
      await wait(
        async () => invalidations(),
        (events) => events.length === initialEvents + 16,
        "settled transfer publication count",
      );
      result.live = invalidations()
        .slice(initialEvents)
        .map((event) => ({
          scope: event.scope,
          resource: event.resource,
          action: event.action,
          entityId: event.entityId,
          payload: event.payload,
        }));
      mode = "early";
      await begin(4, "http-handoff-destination");
      await wait(
        async () =>
          result.commands.filter(
            (command) => command.operationId === operation(4),
          ).length,
        (count) => count === 1,
        "early transport acknowledgement",
      );
      assert.equal((await state(4)).phase, "preparing");
      await h.live.close();
      const port = Number(new URL(h.fixture.server.origin).port),
        priorConnections = h.connectionCount();
      await h.fixture.close();
      // Write the real queued preparation while the server is stopped, so its
      // reconnect hook must join this same durable handoff before claiming it.
      const offline = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: h.fixture.environment.DATABASE_URL,
      });
      let queuedPreparation;
      try {
        const requested = await offline.request({
          op: "preparation-request",
          owner: h.owner,
          chat: settingsChat,
          worker: settingsWorker,
        });
        assert.equal(requested.rejected, false, requested.diagnostic);
        queuedPreparation = requested.value;
        assert.ok(queuedPreparation);
      } finally {
        await offline.close();
      }
      mode = "recover-held";
      await h.fixture.start({ port });
      await wait(
        async () => h.connectionCount(),
        (count) => count > priorConnections,
        "existing worker reconnects to restarted server",
      );
      await wait(
        async () =>
          held.some((command) => command.operationId === operation(4)),
        Boolean,
        "worker recovery is actually held",
      );
      const waitingPreparation = await readPreparation();
      assert.equal(waitingPreparation.generation, queuedPreparation.generation);
      assert.equal(waitingPreparation.phase, queuedPreparation.phase);
      assert.deepEqual(result.preparationCommands, []);
      release(4);
      const recovered = await wait(
        () => state(4),
        (value) => value.phase === "completed",
        "restart redispatches durable reservation",
      );
      assert.equal(recovered.binding.modelRouteId, "http-handoff-destination");
      assert.equal(
        result.commands.filter(
          (command) => command.operationId === operation(4),
        ).length,
        2,
      );
      await h.visit(
        "restart recovered transfer",
        "GET",
        `${route}/${operation(4)}`,
      );
      const preparedConsole = await wait(
        readPreparation,
        (value) => value?.phase === "ready",
        "reconnected console joins committed handoff",
      );
      assert.notEqual(preparedConsole.generation, queuedPreparation.generation);
      assert.ok(result.preparationCommands.includes("terminal.detach"));
      result.proofs.push(
        "early worker acknowledgement cannot complete a transfer; restart discovers and redispatches its durable reservation",
      );
      result.proofs.push(
        "real queued preparation retains its generation while handoff recovery is held, then opens the destination console after settlement",
      );
      mode = "hold";
      await begin(5, "http-handoff-source");
      await wait(
        async () => held.some((item) => item.operationId === operation(5)),
        Boolean,
        "pending command before shutdown",
      );
      const shutdownConnections = h.connectionCount();
      await h.fixture.close();
      release(5);
      mode = "early";
      await h.fixture.start({ port });
      await wait(
        async () => h.connectionCount(),
        (count) => count > shutdownConnections,
        "worker reconnects after pending-command shutdown",
      );
      await wait(
        async () =>
          result.commands.filter(
            (command) => command.operationId === operation(5),
          ).length,
        (count) => count === 2,
        "shutdown reservation remains recoverable",
      );
      const shutdownState = await state(5);
      assert.equal(shutdownState.errorCode, "handoff-worker-unavailable");
      assert.equal(shutdownState.phase, "preparing");
      await wait(
        readPreparation,
        (value) =>
          value?.phase === "ready" &&
          value.generation !== preparedConsole.generation,
        "all reconnect preparation persistence settles before final cleanup",
      );
      result.proofs.push(
        "shutdown settles a command without a deadline and persists diagnostics before database close",
      );
      await h.close();
      active = null;
    }
    assert.deepEqual(outputs[1].proofs, outputs[0].proofs);
    assert.deepEqual(outputs[1].commands, outputs[0].commands);
    assert.deepEqual(
      outputs[1].preparationCommands,
      outputs[0].preparationCommands,
    );
    assert.deepEqual(outputs[1].live, outputs[0].live);
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      "Actual HTTP bodies, errors and security headers must match",
    );
  }
} catch (error) {
  failure = error;
  report.error = {
    message: error.message,
    stack: error.stack,
    diagnostics: active?.diagnostics(),
  };
} finally {
  releasePending();
  await delay(0);
  try {
    await active?.close();
    await pg?.close();
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      "Handoff HTTP cleanup failed",
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
