import { ManagedNativeQueue } from "../src/codex/managed-native-queue.js";
import type { ManagedNativeQueueClient } from "../src/managed-native-queue-client.js";
import { createManagedQueueInputCodec } from "../src/managed-queue-input.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import {
  ManagedNativeCommandSession,
  type ManagedNativeCommandSessionOptions,
} from "../src/codex/managed-native-command-session.js";
import type { NativeCommandClient } from "../src/native-command-client.js";
import path from "node:path";
import { expect, vi } from "vitest";
import type { NativeRuntimeHandoffState } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
import type { HandoffRuntime } from "../src/codex/managed-runtime-handoff.js";
import { ManagedRuntimeHandoffPublication } from "../src/codex/managed-runtime-handoff-publication.js";
import {
  ManagedSessionCoordinator,
  type ManagedSessionIdentity,
} from "../src/codex/managed-session.js";
import { withManagedSessionMcpServers } from "../src/codex/managed-session-mcp.js";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../src/codex/managed-native-gateway.js";
import { TerminalManager } from "../src/terminal-manager.js";

/** Real native TUI, gateway, preserving coordinator and terminal replacement.
 * Real authenticated command admission authorizes attachment; no model turn is submitted. */
export async function createNativeHandoffPublicationFixture(options: {
  root: string;
  binary: string;
  identity: ManagedSessionIdentity;
  threadId: string;
  source: HandoffRuntime;
  beforeRetarget(): void;
  client: NativeCommandClient;
  queueClient: ManagedNativeQueueClient;
  queuedId: string;
  configurationHome(staged: HandoffRuntime): string;
  encryption: ManagedNativeCommandSessionOptions["encryption"];
}) {
  const { identity, threadId } = options;
  const terminals = new TerminalManager({
    environment: { HOME: options.root },
  });
  const sessions = new ManagedSessionCoordinator(
    path.join(options.root, "publication-sessions"),
  );
  let current = options.source.runtime as CodexAppServer;
  let attachedRuntime = current;
  const gateways = new Map<CodexAppServer, ManagedNativeGateway>();
  const resumed = new Map<CodexAppServer, number>();
  const retired: CodexAppServer[] = [];
  const queueReads = new Map<CodexAppServer, unknown>();
  let settled = false;
  let terminalOutput = "";
  let terminal: Promise<unknown> | undefined;
  const gatewayFor = async (
    runtime: CodexAppServer,
    configuration: HandoffRuntime["configuration"],
    upstreamUrl: string,
  ) => {
    const previous = gateways.get(runtime);
    if (previous) return previous;
    const generation = runtime.transportGeneration!;
    const adapter = new ManagedNativeCommandSession({
      identity,
      runtime,
      client: options.client,
      encryption: options.encryption,
      policy: {
        cwd: configuration.cwd,
        codexHome: runtime.managedHistoryHome,
        permissionProfileId: configuration.permissionProfileId,
        security: {
          permissions: configuration.permissionProfileId,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
      },
      beginExecution: async () => {
        throw new Error("Publication fixture submits no model input");
      },
      onError: (error) => {
        console.error(error);
      },
    });
    const queueIdentity = {
      ...identity,
      threadId,
      runtimeGeneration: generation,
      modelRouteId: configuration.model.routeId,
      providerAccountId: configuration.provider.accountId ?? null,
    };
    const codec = createManagedQueueInputCodec({
      encryption: options.encryption as WorkerEncryptionService,
      chatId: identity.chatId,
      defaults: () => ({
        mode: "default",
        modelId: configuration.model.id,
        reasoningEffort: null,
        worktreeId: identity.placementId,
      }),
    });
    const queue = new ManagedNativeQueue({
      identity: queueIdentity,
      client: options.queueClient,
      encryption: options.encryption,
      policy: {
        cwd: configuration.cwd,
        codexHome: runtime.managedHistoryHome,
        permissionProfileId: configuration.permissionProfileId,
        security: {},
      },
      currentActivationGeneration: () => null,
      preparePrompt: codec.preparePrompt,
      openPrompt: codec.openPrompt,
    });
    const gateway = await createManagedNativeGateway({
      identity: {
        ...identity,
        threadId,
        runtimeGeneration: generation,
        modelRouteId: configuration.model.routeId,
        providerAccountId: configuration.provider.accountId ?? null,
      },
      upstreamUrl,
      queue: {
        subscribe: (listener) => queue.subscribe(listener),
        execute: async (request) => {
          const result = await queue.execute(request);
          if (request.method === "thread/queue/list")
            queueReads.set(runtime, result);
          return result;
        },
      },
      isCurrent: () =>
        current === runtime && runtime.transportGeneration === generation,
      admit: async (operation) => {
        const admitted = await adapter.admit(operation);
        return {
          ...admitted,
          settle: async (receipt) => {
            await admitted.settle(receipt);
            if (
              operation.method === "thread/resume" &&
              receipt &&
              !receipt.error
            )
              resumed.set(runtime, (resumed.get(runtime) ?? 0) + 1);
          },
        };
      },
      resolveReply: (operation, response) =>
        adapter.resolveReply(operation, response),
    });
    gateways.set(runtime, gateway);
    return gateway;
  };
  const close = async () => {
    terminals.closeAll();
    await terminal;
    for (const gateway of gateways.values()) await gateway.close();
  };
  try {
    await current.prepareManagedThread({
      ...options.source.configuration,
      threadId,
      intent: "preserve",
    });
    const sourceGateway = await gatewayFor(
      current,
      options.source.configuration,
      await current.remoteEndpoint(
        options.source.configuration.model,
        options.source.configuration.provider,
      ),
    );
    terminal = terminals
      .open(
        "handoff-view",
        "initial-view",
        options.source.configuration.cwd,
        130,
        45,
        {
          type: "codex",
          binary: options.binary,
          codexHome: options.source.home,
          remoteUrl: sourceGateway.url,
          threadId,
          model: options.source.configuration.model,
          provider: options.source.configuration.provider,
          session: {
            chatId: identity.chatId,
            contextKind: "project",
            projectId: identity.projectId!,
            worktreeId: identity.placementId,
            rootKind: "git-worktree",
            scratchRootId: null,
            computerUseEnabled: false,
          },
        },
        (event) => {
          if (event.type !== "terminal.output") return;
          terminalOutput += event.data;
          try {
            if (event.data.includes("\x1b[6n"))
              terminals.input("handoff-view", "\x1b[1;1R");
            if (event.data.includes("\x1b[c"))
              terminals.input("handoff-view", "\x1b[?1;2c");
            if (event.data.includes("\x1b]10;?"))
              terminals.input(
                "handoff-view",
                "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
              );
            if (event.data.includes("\x1b]11;?"))
              terminals.input(
                "handoff-view",
                "\x1b]11;rgb:0000/0000/0000\x1b\\",
              );
          } catch {
            /* Late query from the retiring PTY. */
          }
        },
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(resumed.get(current)).toBeGreaterThan(0), {
      timeout: 15000,
    });
    const publisher = new ManagedRuntimeHandoffPublication({
      current: () => current,
      prepare: async (_state, staged) => {
        const runtime = staged.runtime as CodexAppServer;
        const result = await sessions.prepare({
          identity,
          runtime: withManagedSessionMcpServers(
            runtime,
            [],
            async () => staged.configuration.mcpServers ?? [],
          ),
          configuration: {
            ...staged.configuration,
            threadId,
            intent: "preserve",
            mcpServers: undefined,
          },
        });
        return {
          ...result,
          activate: () => {
            current = runtime;
          },
          runtime,
          subagentDefaults: staged.configuration.subagentDefaults,
          executionProfile: staged.configuration.executionProfile,
          codexHome: options.configurationHome(staged),
          gateway: (upstreamUrl) =>
            gatewayFor(runtime, staged.configuration, upstreamUrl),
        };
      },
      terminals: {
        retargetManagedCodex: async (...args) => {
          options.beforeRetarget();
          await terminals.retargetManagedCodex(...args);
          expect(settled, terminalOutput).toBe(false);
        },
      },
      retire: async (_state, runtime) => {
        await gateways.get(runtime)?.close();
        gateways.delete(runtime);
        retired.push(runtime);
      },
    });
    return {
      retired,
      async publish(
        state: NativeRuntimeHandoffState,
        staged: HandoffRuntime,
        side: "source" | "destination",
      ) {
        const runtime = staged.runtime as CodexAppServer;
        const before = (await runtime.readNativeThreadSettings(threadId))
          .confirmed!.settings;
        const count = resumed.get(runtime) ?? 0;
        const replaced = attachedRuntime !== runtime;
        await publisher.publish(state, staged, side);
        attachedRuntime = runtime;
        if (replaced)
          await vi.waitFor(
            () => expect(resumed.get(runtime)).toBeGreaterThan(count),
            { timeout: 15000 },
          );
        expect(
          (await runtime.readNativeThreadSettings(threadId)).confirmed!
            .settings,
        ).toEqual(before);
        await vi.waitFor(
          () => {
            expect(JSON.stringify(queueReads.get(runtime))).toContain(
              options.queuedId,
            );
            expect(JSON.stringify(queueReads.get(runtime))).toContain(
              "QUEUED_HANDOFF_SENTINEL",
            );
          },
          { timeout: 15000 },
        );
        expect(settled, terminalOutput).toBe(false);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
