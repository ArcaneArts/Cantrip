// A disposable real worker adapter: native runtime, managed gateway and PTY.
// No model input, accounts, user directories, or substitute history writers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.ts";
import { discoverCodexRuntime } from "../../cantrip_worker/src/codex/discovery.ts";
import { ManagedSessionCoordinator } from "../../cantrip_worker/src/codex/managed-session.ts";
import { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.ts";
import { ManagedNativeQueue } from "../../cantrip_worker/src/codex/managed-native-queue.ts";
import { createManagedNativeGateway } from "../../cantrip_worker/src/codex/managed-native-gateway.ts";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.ts";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.ts";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.ts";
import { TerminalManager } from "../../cantrip_worker/src/terminal-manager.ts";
import { prepareManagedConsoleState } from "../../cantrip_worker/src/managed-console-state.ts";
import { openTerminalPrivateState } from "../../cantrip_worker/src/terminal-private-state.ts";
import { readProtectedNativeSettings } from "../../cantrip_worker/src/native-settings-read.ts";

export async function nativePreparationWorker({ root, binary }) {
  const home = path.join(root, "codex-home"),
    cwd = path.join(root, "worktree"),
    processGeneration = "native-preparation-process";
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(home, "config.toml"),
    "features.plugins=false\nfeatures.goals=true\n",
  );
  const providerRequests = [],
    commands = [],
    opened = [];
  const responses = [],
    failures = [];
  const provider = createServer((request, response) => {
    providerRequests.push(request.url);
    request.resume();
    response.writeHead(500).end("This preparation fixture must not infer.");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let fixture,
    child,
    closed,
    runtime,
    gateway,
    scope,
    identity,
    resumed = 0;
  const sessions = new ManagedSessionCoordinator(path.join(root, "sessions"));
  const terminals = new TerminalManager({
    environment: { HOME: root },
    observeLifecycle: (event) => {
      if (event.managedPreparationGeneration && fixture) {
        assert.equal(
          fixture.worker.sendNotification({
            type: "terminal.runtime.observed",
            terminalId: event.terminalId,
            managedPreparationGeneration: event.managedPreparationGeneration,
            workerProcessGeneration: processGeneration,
            status: "exited",
            exitCode: event.exitCode ?? null,
            signal: event.signal ?? null,
          }),
          true,
        );
      }
    },
  });
  const ensureRuntime = async () => {
    if (!runtime)
      runtime = new CodexAppServer(
        binary,
        path.join(home, "runtime"),
        home,
        await discoverCodexRuntime(binary, path.join(root, "probe")),
        undefined,
        undefined,
        undefined,
        (file, args, options) => {
          child = spawn(file, args, {
            ...options,
            env: { ...options.env, HOME: root },
            stdio: "pipe",
          });
          closed = once(child, "close");
          return child;
        },
      );
    return runtime;
  };
  const commandClient = () => {
    const connected = fixture;
    return new NativeCommandClient({
      serverUrl: connected.fixture.server.origin,
      workerId: scope.workerId,
      token: () => connected.credential,
      fetch: async (...args) => {
        const response = await fetch(...args);
        responses.push({
          path: new URL(args[0]).pathname,
          status: response.status,
          body: await response
            .clone()
            .json()
            .catch(() => null),
        });
        return response;
      },
    });
  };
  async function handle(command, emit, { encryption, owner, serverId }) {
    if (
      ![
        "chat.thread.ensure",
        "chat.settings.read",
        "terminal.prepare-state",
        "terminal.open",
        "terminal.detach",
        "worker-link.identity.resolve",
      ].includes(command.type)
    )
      return undefined;
    commands.push(command.type);
    if (command.type === "worker-link.identity.resolve")
      return {
        serverId,
        ownerId: owner,
        workerId: scope.workerId,
        workerProcessGeneration: processGeneration,
      };
    if (command.type === "chat.thread.ensure") {
      const native = await ensureRuntime();
      identity = {
        serverId,
        ownerId: owner,
        workerId: command.session ? fixture.scope.workerId : scope.workerId,
        chatId: command.session.chatId,
        contextKind: "project",
        projectId: command.session.projectId,
        placementId: command.session.worktreeId,
      };
      const prepared = await sessions.prepare({
        identity,
        runtime: native,
        configuration: {
          ...command,
          provider: { ...command.provider, apiKey: null },
          intent: "preserve",
          executionProfile: "ide",
          canonicalHistory: true,
        },
      });
      scope = {
        chatId: identity.chatId,
        workerId: identity.workerId,
        threadId: prepared.threadId,
        contextKind: identity.contextKind,
        projectId: identity.projectId,
        placementId: identity.placementId,
        modelRouteId: command.model.routeId,
        providerAccountId: command.provider.accountId ?? null,
      };
      return prepared;
    }
    if (command.type === "chat.settings.read")
      return readProtectedNativeSettings({
        scope: command.scope,
        resolve: () => ({
          scope,
          runtime,
          generation: runtime.transportGeneration,
        }),
        service: encryption,
      });
    if (command.type === "terminal.prepare-state")
      return prepareManagedConsoleState(
        command.terminalId,
        command.serverId,
        encryption,
      );
    if (command.type === "terminal.detach")
      return terminals.detach(command.terminalId, command.attachmentId);
    assert.equal(command.launch.type, "codex");
    const state = await openTerminalPrivateState({
      ...command,
      service: encryption,
    });
    assert.equal(state.serviceCommand, "");
    await commandClient().refreshSettings(identity.chatId);
    const launch = command.launch;
    if (!gateway) {
      const connected = fixture;
      const policy = {
        cwd,
        codexHome: runtime.managedHistoryHome,
        permissionProfileId: ":workspace",
        security: {
          permissions: ":workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
      };
      const adapter = new ManagedNativeCommandSession({
        identity,
        runtime,
        client: commandClient(),
        encryption,
        policy,
        beginExecution: async () => {
          throw new Error("Preparation must not acquire model input");
        },
        onError: (error) => {
          throw error;
        },
      });
      const queueIdentity = {
        ...identity,
        threadId: launch.threadId,
        runtimeGeneration: runtime.transportGeneration,
        modelRouteId: launch.model.routeId,
        providerAccountId: launch.provider.accountId ?? null,
      };
      const codec = createManagedQueueInputCodec({
        encryption,
        chatId: identity.chatId,
        defaults: () => ({
          mode: "default",
          modelId: launch.model.id,
          reasoningEffort: null,
          worktreeId: identity.placementId,
        }),
      });
      const queue = new ManagedNativeQueue({
        identity: queueIdentity,
        client: new ManagedNativeQueueClient({
          serverUrl: fixture.fixture.server.origin,
          workerId: identity.workerId,
          token: () => connected.credential,
        }),
        encryption,
        policy,
        currentActivationGeneration: () => null,
        preparePrompt: codec.preparePrompt,
        openPrompt: codec.openPrompt,
      });
      gateway = await createManagedNativeGateway({
        identity: queueIdentity,
        upstreamUrl: await runtime.remoteEndpoint(launch.model, {
          ...launch.provider,
          apiKey: null,
        }),
        isCurrent: () => true,
        queue: {
          subscribe: (listener) => queue.subscribe(listener),
          execute: (request) => queue.execute(request),
        },
        admit: async (operation) => {
          const admission = await adapter.admit(operation);
          return {
            ...admission,
            settle: async (receipt) => {
              try {
                await admission.settle(receipt);
              } catch (error) {
                failures.push({
                  method: operation.method,
                  name: error.name,
                  message: error.message,
                  code: error.code ?? null,
                });
                throw error;
              }
              if (
                operation.method === "thread/resume" &&
                receipt &&
                !receipt.error
              )
                resumed++;
            },
          };
        },
        resolveReply: (operation, response) =>
          adapter.resolveReply(operation, response),
      });
    }
    const result = terminals.open(
      command.terminalId,
      command.attachmentId,
      state.cwd,
      command.cols,
      command.rows,
      {
        ...launch,
        binary,
        codexHome: home,
        remoteUrl: gateway.url,
        provider: { ...launch.provider, apiKey: null },
      },
      (event) => {
        if (event.type === "terminal.ready") emit(event);
      },
      command.managedPreparationGeneration,
    );
    opened.push(result);
    return result;
  }
  return {
    cwd,
    providerUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    handle,
    attach: (h) => (fixture = h),
    commands,
    responses,
    failures,
    providerRequests,
    resumes: () => resumed,
    isLive: (id) => terminals.hasLiveSession(id),
    closeConsole: (id) => terminals.close(id),
    history: () => runtime.readNativeHistory(scope.threadId),
    async close() {
      fixture = null;
      terminals.closeAll();
      await Promise.allSettled(opened);
      await gateway?.close();
      const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
      runtime?.close();
      await closed;
      clearTimeout(force);
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    },
  };
}
