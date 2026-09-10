import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.js";
import { installInternalNativeQueueRoutes } from "../src/app/routes/internal-native-queue.js";
import { seedHandoffHistory } from "../../cantrip_worker/test/native-handoff-history-fixture.js";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import { createNativeHandoffPublicationFixture } from "../../cantrip_worker/test/native-handoff-publication-fixture.js";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import Fastify from "fastify";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import type { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { runtimeHandoffConfiguration } from "../src/terminals/runtime-handoff-configuration.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import { installInternalNativeRuntimeHandoffRoutes } from "../src/app/routes/internal-native-runtime-handoffs.js";
import { NativeRuntimeHandoffClient } from "../../cantrip_worker/src/native-runtime-handoff-client.js";
import { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.js";
import { discoverCodexRuntime } from "../../cantrip_worker/src/codex/discovery.js";
import {
  ManagedRuntimeHandoffCoordinator,
  type HandoffRuntime,
} from "../../cantrip_worker/src/codex/managed-runtime-handoff.js";
import { ManagedRuntimeNamespaces } from "../../cantrip_worker/src/codex/managed-runtime-namespaces.js";
import { ManagedRuntimeHandoffJournal } from "../../cantrip_worker/src/codex/managed-runtime-handoff-journal.js";
import { protectNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.js";

/** Real native engines, encrypted snapshots, authenticated worker HTTP and real
 * migrated storage. A deterministic fake response seeds native history; handoff
 * makes no inference requests. No actual provider credentials or user apps. */
export async function exerciseNativeHandoff(
  f: Awaited<ReturnType<typeof createNativeSettingsFixture>>,
  targetRoute: string,
  attachCli = false,
) {
  const binary = process.env.CANTRIP_CODEX_TEST_BINARY!;
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-handoff-native-"));
  const calls: string[] = [];
  const accountId = attachCli ? "handoff-fixture-account" : null;
  const accountHome = path.join(root, "accounts", "fixture-credential-home");
  const accountConfig =
    'features.plugins=false\nmodel_reasoning_effort="high"\nservice_tier="priority"\n';
  let seedResponse = false;
  const provider = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (!seedResponse) {
      response.writeHead(500).end("No inference during handoff");
      return;
    }
    seedResponse = false;
    request.resume();
    const events = [
      { type: "response.created", response: { id: "fixture-seed" } },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "fixture-answer",
          content: [{ type: "output_text", text: "Retained fixture answer" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "fixture-seed",
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  const app = Fastify();
  const entries: { runtime: CodexAppServer; close(): Promise<void> }[] = [];
  let publication:
    | Awaited<ReturnType<typeof createNativeHandoffPublicationFixture>>
    | undefined;
  try {
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    await f.db.update(schema.modelProviders).set({ baseUrl });
    if (accountId) {
      const [route] = await f.db
        .select()
        .from(schema.modelRoutes)
        .where(eq(schema.modelRoutes.id, targetRoute));
      await f.db
        .update(schema.modelProviders)
        .set({ kind: "grok" })
        .where(eq(schema.modelProviders.id, route!.providerId));
      await f.db.insert(schema.modelProviderAccounts).values({
        id: accountId,
        providerId: route!.providerId,
        credentialHomeKey: "fixture-credential-home",
        enabled: true,
        protectedLabel: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      });
      await mkdir(accountHome, { recursive: true });
      await writeFile(path.join(accountHome, "config.toml"), accountConfig);
    }

    const previous = (await f.repository.getChatExecutionContext(
      owner,
      f.chatId,
    ))!;
    const sourceRoute = previous.modelRouteId!;
    const selected = (await f.repository.getModelRuntimeByRoute(
      owner,
      sourceRoute,
    ))!;
    await mkdir(previous.cwd, { recursive: true });
    const compatibility = await discoverCodexRuntime(
      binary,
      path.join(root, "probe"),
    );
    const createRuntime = async (
      home: string,
      configurationHome: string | null = null,
    ) => {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\nfeatures.goals=true\n",
      );
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<unknown> | undefined;
      const runtime = new CodexAppServer(
        binary,
        path.join(home, "runtime"),
        home,
        compatibility,
        undefined,
        undefined,
        undefined,
        (file, args, options) => {
          const process = spawn(file, args, {
            ...options,
            env: { ...options.env, HOME: root },
            stdio: "pipe",
          });
          child = process;
          closed = once(process, "close");
          return process;
        },
        [],
        configurationHome,
      );
      const entry = {
        runtime,
        close: async () => {
          const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
          runtime.close();
          await closed;
          clearTimeout(force);
        },
      };
      entries.push(entry);
      return entry;
    };
    const reloadCore = async (
      runtime: CodexAppServer,
      model: HandoffRuntime["configuration"]["model"],
      provider: HandoffRuntime["configuration"]["provider"],
      threadId: string,
    ) => {
      // Unsubscribe only detaches a view. Archive/unarchive in this isolated
      // fixture actually tears down the Core while retaining its conversation.
      const socket = new WebSocket(
        await runtime.remoteEndpoint(model, provider, {
          executionProfile: "ide",
        }),
      );
      await once(socket, "open");
      let sequence = 0;
      const rpc = (method: string, params: unknown) =>
        new Promise<void>((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(
            () => finish(new Error(`Fixture RPC timed out: ${method}`)),
            15000,
          );
          const receive = (data: WebSocket.RawData) => {
            const frame = JSON.parse(data.toString());
            if (frame.id !== id) return;
            finish(
              frame.error ? new Error(JSON.stringify(frame.error)) : undefined,
            );
          };
          const closed = () =>
            finish(new Error(`Fixture RPC disconnected: ${method}`));
          const finish = (error?: Error) => {
            clearTimeout(timer);
            socket.off("message", receive);
            socket.off("close", closed);
            error ? reject(error) : resolve();
          };
          socket.on("message", receive);
          socket.on("close", closed);
          socket.send(JSON.stringify({ id, method, params }));
        });
      try {
        await rpc("initialize", {
          clientInfo: { name: "handoff-reload-fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        await rpc("thread/archive", { threadId });
        await rpc("thread/unarchive", { threadId });
      } finally {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
      await runtime.releaseRelocationThread(threadId, model, provider);
    };
    let source = await createRuntime(path.join(root, "source"));
    const byHome = new Map([[source.runtime.managedHistoryHome, source]]);
    const sourceConfiguration = {
      cwd: previous.cwd,
      model: selected.model,
      provider: { ...selected.provider, apiKey: null },
      permissionProfileId: ":workspace",
      planMode: "default" as const,
      subagentDefaults: null,
      mcpServers: [],
      executionProfile: "ide" as const,
      canonicalHistory: true,
    };
    const initial = await source.runtime.prepareManagedThread({
      ...sourceConfiguration,
      threadId: null,
      intent: "configure",
    });
    let retained: Awaited<ReturnType<typeof seedHandoffHistory>> | undefined;
    if (attachCli) {
      seedResponse = true;
      retained = await seedHandoffHistory(
        source.runtime,
        sourceConfiguration,
        initial.threadId,
      );
      expect(calls).toHaveLength(1);
      calls.length = 0;
    }
    const verifyRetained = async (target: HandoffRuntime) => {
      if (!retained) return;
      const runtime = target.runtime as CodexAppServer;
      expect(
        (await runtime.readNativeHistory(initial.threadId)).thread.turns,
      ).toEqual(retained.history.thread.turns);
      expect(
        await runtime.getGoal({
          ...target.configuration,
          threadId: initial.threadId,
        }),
      ).toEqual(retained.goal);
    };
    await f.db
      .update(schema.chatRuntimeSessions)
      .set({ codexThreadId: initial.threadId })
      .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
    const crypto = {
      ownerId: () => owner,
      serverIdentity: () => "fixture-server",
      componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 19) }),
    };
    let queuedId: string | undefined;
    if (attachCli) {
      const codec = createManagedQueueInputCodec({
        encryption: crypto as WorkerEncryptionService,
        chatId: f.chatId,
        defaults: () => ({
          mode: "default",
          modelId: selected.model.id,
          reasoningEffort: null,
          worktreeId: previous.worktreeId,
        }),
      });
      const queueInput = await codec.preparePrompt({
        id: randomUUID(),
        request: {
          method: "thread/queue/add",
          params: {
            threadId: initial.threadId,
            input: [{ type: "text", text: "Retain QUEUED_HANDOFF_SENTINEL" }],
            clientUserMessageId: "handoff-queued-input",
            managed: { action: "literal" },
          },
          identity: {
            serverId: crypto.serverIdentity(),
            ownerId: owner,
            workerId: f.workerId,
            chatId: f.chatId,
            threadId: initial.threadId,
            contextKind: "project",
            projectId: previous.projectId,
            placementId: previous.worktreeId!,
            runtimeGeneration: source.runtime.transportGeneration!,
            modelRouteId: selected.model.routeId,
            providerAccountId: null,
          },
          connectionId: "fixture-gui",
          signal: new AbortController().signal,
          assertCurrent: () => {},
        },
      });
      const queued = await f.repository.createEncryptedQueuedPrompt(
        owner,
        f.chatId,
        queueInput.prompt,
        queueInput.attachments,
      );
      expect(queued).not.toBeNull();
      queuedId = queued!.id;
    }
    const seal = async (
      runtime: HandoffRuntime["runtime"],
      configuration: HandoffRuntime["configuration"],
    ) => {
      const settings = (
        await runtime.readNativeThreadSettings(initial.threadId)
      ).confirmed!.settings;
      return protectNativeSettingsSnapshot({
        service: crypto,
        settings,
        context: {
          chatId: f.chatId,
          workerId: f.workerId,
          threadId: initial.threadId,
          runtimeGeneration: runtime.transportGeneration!,
          settingsVersion: settings.settingsVersion!,
        },
        modelAttribution: {
          status: "resolved",
          workerId: f.workerId,
          providerId: configuration.provider.id,
          providerAccountId: configuration.provider.accountId ?? null,
          modelId: configuration.model.id,
          routeId: configuration.model.routeId,
        },
      });
    };
    const settingsState = await f.commands.refreshSettingsState(
      owner,
      f.chatId,
      () => seal(source.runtime, sourceConfiguration),
    );
    const job = await f.repository.nativeRuntimeHandoffs.begin(
      owner,
      f.chatId,
      {
        operationId: randomUUID(),
        bindingId: settingsState.binding!.bindingId,
        targetModelRouteId: targetRoute,
        targetProviderAccountId: accountId,
      },
    );
    // A source restart must recover its binding before export and still commit.
    const sourceHome = source.runtime.managedHistoryHome;
    if (!attachCli) {
      await source.close();
      source = await createRuntime(sourceHome);
      byHome.set(sourceHome, source);
    }
    installInternalNativeRuntimeHandoffRoutes(app, {
      repository: f.repository,
      config: f.config,
      runAsOwner: (_owner, run) => run(),
      live: { publishChatInvalidation: () => {} },
      configuration: (ownerId, state, side) =>
        runtimeHandoffConfiguration(ownerId, state, side, {
          repository: f.repository,
          routePairsForConfiguration: async (_context, configuration, roots) =>
            resolveModelRoutePairs({
              configuration,
              rootRuntimes: roots ?? [],
            }),
        }),
    });
    installInternalNativeCommandRoutes(app, {
      repository: f.repository,
      config: f.config,
      serverId: crypto.serverIdentity(),
      runAsOwner: (_owner, run) => run(),
      dispatchNextQueuedPrompt: async () => {},
      live: {
        publishEncryptedChatMessage: () => {},
        publishTaskMessage: () => {},
        publishChatSummary: () => {},
        publishChatTurnBoundary: () => {},
        publishChatInvalidation: () => {},
      },
    });
    installInternalNativeQueueRoutes(app, {
      repository: f.repository,
      config: f.config,
      runAsOwner: (_owner, run) => run(),
      publishChatInvalidation: () => {},
    });
    const serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    let loseCommit = true;
    let staleRootEffort = true;
    let cancelAfterPrepared = false;
    let preparationReached!: () => void;
    let failRestoration = false;
    let failPublication = false;
    let restorations = 0;
    const client = new NativeRuntimeHandoffClient({
      serverUrl,
      workerId: f.workerId,
      token: () => f.config.workerToken,
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        const command = JSON.parse(options!.body as string);
        if (command.action === "prepared" && staleRootEffort) {
          expect(Object.hasOwn(command.prepared, "reasoningEffort")).toBe(true);
          staleRootEffort = false;
          await f.db
            .update(schema.chats)
            .set({ reasoningEffort: "stale-fixture-effort" })
            .where(eq(schema.chats.id, f.chatId));
        }
        if (command.action === "prepared" && cancelAfterPrepared) {
          expect(response.status).toBe(200);
          cancelAfterPrepared = false;
          await response.arrayBuffer();
          const signal = options!.signal!;
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            preparationReached();
          });
        }
        if (
          JSON.parse(options!.body as string).action === "commit" &&
          loseCommit
        ) {
          expect(response.status).toBe(200);
          loseCommit = false;
          await response.arrayBuffer();
          throw new Error("fixture lost canonical commit response");
        }
        return response;
      },
    });
    const scope = {
      serverId: crypto.serverIdentity(),
      ownerId: owner,
      workerId: f.workerId,
    };
    if (attachCli)
      publication = await createNativeHandoffPublicationFixture({
        root,
        binary,
        client: new NativeCommandClient({
          serverUrl,
          workerId: f.workerId,
          token: () => f.config.workerToken,
        }),
        encryption: crypto,
        queueClient: new ManagedNativeQueueClient({
          serverUrl,
          workerId: f.workerId,
          token: () => f.config.workerToken,
        }),
        queuedId: queuedId!,
        configurationHome: (staged) =>
          staged.configuration.provider.accountId ? accountHome : staged.home,
        identity: {
          ...scope,
          chatId: f.chatId,
          contextKind: "project",
          projectId: job.source.projectId,
          placementId: job.source.placementId,
        },
        threadId: initial.threadId,
        source: {
          runtime: source.runtime,
          home: source.runtime.managedHistoryHome,
          configuration: sourceConfiguration,
        },
        beforeRetarget: () => {
          if (failPublication) throw new Error("fixture publication paused");
          if (failRestoration)
            throw new Error("fixture source publication failed");
        },
      });
    const namespaces = new ManagedRuntimeNamespaces(root);
    let destination: Awaited<ReturnType<typeof createRuntime>> | undefined;
    const resolutions: string[] = [];
    let publications = 0;
    const coordinator = () =>
      new ManagedRuntimeHandoffCoordinator({
        client,
        scope,
        namespaces,
        journal: new ManagedRuntimeHandoffJournal(root, scope),
        resolve: async (state, side) => {
          resolutions.push(side);
          const { configuration } = await client.configuration({
            chatId: f.chatId,
            operationId: state.operationId,
            side,
          });
          const home =
            side === "source"
              ? (namespaces.current(scope, initial.threadId)?.home ??
                source.runtime.managedHistoryHome)
              : namespaces.destination(
                  scope,
                  initial.threadId,
                  state.operationId,
                );
          let entry = byHome.get(home);
          if (!entry) {
            entry = await createRuntime(
              home,
              configuration.provider.accountId ? accountHome : null,
            );
            byHome.set(home, entry);
          }
          if (side === "destination") destination = entry;
          const runtime = entry.runtime;
          expect(configuration.provider.protectedApiKey).toBeNull();
          return {
            runtime,
            home: runtime.managedHistoryHome,
            configuration: {
              ...configuration,
              provider: { ...configuration.provider, apiKey: null },
              subagentDefaults: null,
              mcpServers: [],
              executionProfile: "ide",
              canonicalHistory: true,
            },
          };
        },
        protectSettings: async (_state, _side, runtime) =>
          seal(runtime.runtime, runtime.configuration),
        restoreSource: async (state, runtime) => {
          expect(state.cancelRequested).toBe(true);
          expect(state.phase).toBe("prepared");
          expect(
            (await f.repository.getChatExecutionContext(owner, f.chatId))
              ?.modelRouteId,
          ).toBe(sourceRoute);
          expect(
            namespaces.current(scope, initial.threadId)?.operationId,
          ).not.toBe(state.operationId);
          expect(
            (await runtime.runtime.readNativeHistory(initial.threadId)).thread
              .id,
          ).toBe(initial.threadId);
          if (publication) await publication.publish(state, runtime, "source");
          else if (failRestoration)
            throw new Error("fixture source publication failed");
          await verifyRetained(runtime);
          restorations++;
        },
        publish: async (state, runtime) => {
          expect(state.phase).toBe("committed");
          expect(
            (await f.repository.getChatExecutionContext(owner, f.chatId))
              ?.modelRouteId,
          ).toBe(state.targetModelRouteId);
          expect(namespaces.current(scope, initial.threadId)?.operationId).toBe(
            state.operationId,
          );
          expect(
            (await runtime.runtime.readNativeHistory(initial.threadId)).thread
              .id,
          ).toBe(initial.threadId);
          const actual = (
            await runtime.runtime.readNativeThreadSettings(initial.threadId)
          ).confirmed!.settings;
          expect(
            (await f.repository.getChatExecutionContext(owner, f.chatId))!
              .modelConfiguration.reasoningEffort,
          ).toBe(actual.effort ?? null);
          if (publication)
            await publication.publish(state, runtime, "destination");
          else if (failPublication)
            throw new Error("fixture publication paused");
          await verifyRetained(runtime);
          publications++;
        },
      });
    await expect(
      coordinator().run(
        f.chatId,
        job.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("fixture lost canonical commit response");
    expect(publications).toBe(0);
    expect(namespaces.current(scope, initial.threadId)).toBeNull();
    expect(
      (
        await f.repository.nativeRuntimeHandoffs.get(
          owner,
          f.chatId,
          job.operationId,
        )
      )?.phase,
    ).toBe("committed");
    // Exercise upgrade recovery too: older committed rows lack the binding column.
    await f.db
      .update(schema.nativeRuntimeHandoffs)
      .set({ binding: null })
      .where(eq(schema.nativeRuntimeHandoffs.operationId, job.operationId));
    expect(
      (
        await f.repository.nativeRuntimeHandoffs.get(
          owner,
          f.chatId,
          job.operationId,
        )
      )?.binding,
    ).toEqual((await f.commands.settingsState(owner, f.chatId))!.binding);
    // The acknowledged destination must not depend on retaining its old export.
    await rm(
      path.join(
        sourceHome,
        "managed-history-exports",
        `${job.operationId}.json`,
      ),
    );
    const beforeReload = (await f.commands.settingsState(owner, f.chatId))!
      .binding!;
    const targetConfiguration = (
      await client.configuration({
        chatId: f.chatId,
        operationId: job.operationId,
        side: "destination",
      })
    ).configuration;
    await reloadCore(
      destination!.runtime,
      targetConfiguration.model,
      { ...targetConfiguration.provider, apiKey: null },
      initial.threadId,
    );
    expect(destination!.runtime.transportGeneration).toBe(
      beforeReload.runtimeGeneration,
    );
    failPublication = true;
    await expect(
      coordinator().run(
        f.chatId,
        job.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("fixture publication paused");
    failPublication = false;
    const reloaded = (await f.repository.nativeRuntimeHandoffs.get(
      owner,
      f.chatId,
      job.operationId,
    ))!;
    expect(reloaded.phase).toBe("committed");
    expect(reloaded.binding!.runtimeGeneration).toBe(
      beforeReload.runtimeGeneration,
    );
    expect(reloaded.binding!.nativeEpoch).not.toBe(beforeReload.nativeEpoch);
    expect(reloaded.retiredNativeEpochs).toContainEqual({
      runtimeGeneration: beforeReload.runtimeGeneration,
      nativeEpoch: beforeReload.nativeEpoch,
    });
    expect(reloaded.retiredRuntimeGenerations).not.toContain(
      beforeReload.runtimeGeneration,
    );
    await destination!.close();
    byHome.delete(destination!.runtime.managedHistoryHome);
    destination = undefined;
    resolutions.length = 0;
    const completed = await coordinator().run(
      f.chatId,
      job.operationId,
      new AbortController().signal,
    );
    expect(completed.phase).toBe("completed");
    expect(publications).toBe(1);
    if (publication) expect(publication.retired).toContain(source.runtime);
    expect(resolutions).toEqual(["destination"]);
    expect(completed.retiredRuntimeGenerations.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      (await source.runtime.readNativeHistory(initial.threadId)).thread.id,
    ).toBe(initial.threadId);
    const binding = (await f.commands.settingsState(owner, f.chatId))!.binding!;
    const returning = await f.repository.nativeRuntimeHandoffs.begin(
      owner,
      f.chatId,
      {
        operationId: randomUUID(),
        bindingId: binding.bindingId,
        targetModelRouteId: sourceRoute,
        targetProviderAccountId: null,
      },
    );
    const returned = await coordinator().run(
      f.chatId,
      returning.operationId,
      new AbortController().signal,
    );
    expect(returned.phase).toBe("completed");
    expect(returned.source.threadId).toBe(initial.threadId);
    expect(
      (await f.repository.getChatExecutionContext(owner, f.chatId))
        ?.modelRouteId,
    ).toBe(sourceRoute);
    expect(
      namespaces.current(scope, initial.threadId)?.previousOperationId,
    ).toBe(job.operationId);
    expect(publications).toBe(2);
    const cancelJob = await f.repository.nativeRuntimeHandoffs.begin(
      owner,
      f.chatId,
      {
        operationId: randomUUID(),
        bindingId: (await f.commands.settingsState(owner, f.chatId))!.binding!
          .bindingId,
        targetModelRouteId: targetRoute,
        targetProviderAccountId: accountId,
      },
    );
    const sourceForCancel = byHome.get(
      namespaces.current(scope, initial.threadId)!.home,
    )!;
    await reloadCore(
      sourceForCancel.runtime,
      sourceConfiguration.model,
      sourceConfiguration.provider,
      initial.threadId,
    );
    expect(sourceForCancel.runtime.transportGeneration).toBe(
      cancelJob.source.runtimeGeneration,
    );
    cancelAfterPrepared = true;
    const preparedForCancellation = new Promise<void>((resolve) => {
      preparationReached = resolve;
    });
    const activeCoordinator = coordinator();
    const active = activeCoordinator.run(
      f.chatId,
      cancelJob.operationId,
      new AbortController().signal,
    );
    const interrupted = expect(active).rejects.toThrow(
      "Handoff cancellation requested",
    );
    await preparedForCancellation;
    await f.repository.nativeRuntimeHandoffs.requestCancellation(
      owner,
      f.chatId,
      cancelJob.operationId,
    );
    failRestoration = true;
    await expect(
      activeCoordinator.cancel(
        f.chatId,
        cancelJob.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("fixture source publication failed");
    await interrupted;
    expect(
      (
        await f.repository.nativeRuntimeHandoffs.get(
          owner,
          f.chatId,
          cancelJob.operationId,
        )
      )?.phase,
    ).toBe("prepared");
    failRestoration = false;
    resolutions.length = 0;
    const cancelled = await coordinator().cancel(
      f.chatId,
      cancelJob.operationId,
      new AbortController().signal,
    );
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.binding!.runtimeGeneration).toBe(
      cancelJob.source.runtimeGeneration,
    );
    expect(cancelled.binding!.nativeEpoch).not.toBe(
      cancelJob.source.nativeEpoch,
    );
    expect(cancelled.retiredRuntimeGenerations).not.toContain(
      cancelJob.source.runtimeGeneration,
    );
    expect(restorations).toBe(1);
    expect(resolutions).toEqual(["source"]);
    expect(publications).toBe(2);
    expect(namespaces.current(scope, initial.threadId)?.operationId).toBe(
      returning.operationId,
    );
    expect(calls).toEqual([]);
    if (accountId)
      expect(
        await readFile(path.join(accountHome, "config.toml"), "utf8"),
      ).toBe(accountConfig);
  } finally {
    await publication?.close();
    await app.close();
    for (const entry of entries) await entry.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
