import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encryptChatMessageProtectedContent } from "@cantrip/crypto";
import { acquireChatTurnExecution } from "../../cantrip_server/src/app/runtime/chat-turn-admission.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import type {
  AgentInteractionRuntimeRequest,
  McpServerConfiguration,
} from "@cantrip/protocol";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { ManagedSessionCoordinator } from "../src/codex/managed-session.js";
import { ManagedNativeCommandSession } from "../src/codex/managed-native-command-session.js";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../src/codex/managed-native-gateway.js";
import { NativeCommandClient } from "../src/native-command-client.js";
import { TerminalManager } from "../src/terminal-manager.js";
import { ManagedNativeHistory } from "../src/managed-native-history.js";
import { NativeHistoryClient } from "../src/native-history-client.js";
import { AttachmentStore } from "../src/attachment-store.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { nativePermissionPatch } from "../src/codex/managed-native-permissions.js";
import { createNativeCuaWorkerFixture } from "./native-cua-worker-fixture.js";
import { computerUsePreviewAuthority } from "../../cantrip_server/src/app/routes/computer-use-preview.js";

const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");

/** Actual engine, physical TUI, admitted GUI commands, and encrypted server history.
 * Provider responses are supplied by the caller; native RPC is never mocked. */
export async function createNativeSharedViewFixture(
  binary: string,
  modelBaseUrl: string,
  options: {
    computerUse?: boolean;
    planMode?: "default" | "plan";
    mcpServers?: McpServerConfiguration[];
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-shared-view-"));
  const cwd = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  const data = path.join(directory, "data");
  const children: ChildProcessWithoutNullStreams[] = [];
  const errors: unknown[] = [];
  const turnFailures: unknown[] = [];
  const interactionRequests: AgentInteractionRuntimeRequest[] = [];
  const interactionCleared: string[] = [];
  const interactionExpired: string[] = [];
  const interactionCallbacks = {
    onInteractionRequest: (request: AgentInteractionRuntimeRequest) => {
      interactionRequests.push(request);
    },
    onInteractionCleared: (key: string) => {
      interactionCleared.push(key);
    },
    onInteractionExpired: (key: string) => {
      interactionExpired.push(key);
    },
  };
  const permissionProfileId = options.computerUse ? ":yolo" : ":workspace";
  let cua: Awaited<ReturnType<typeof createNativeCuaWorkerFixture>> | undefined;
  const messages: string[] = [];
  const completed: string[] = [];
  const frames: Record<string, any>[] = [];
  let terminalOutput = "";
  const display = new HeadlessTerminal({
    cols: 130,
    rows: 45,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const terminalText = () => {
    const buffer = display.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, row) => buffer.getLine(row)?.translateToString(true) ?? "",
    ).join("\n");
  };
  let nativeStderr = "";
  let terminalSettled = false;
  let authority:
    Awaited<ReturnType<typeof createNativeCommandWorkerFixture>> | undefined;
  let runtime: CodexAppServer | undefined;
  let gateway: ManagedNativeGateway | undefined;
  let history: ManagedNativeHistory | undefined;
  let terminal: TerminalManager | undefined;
  let attachment: Promise<unknown> | undefined;
  const close = async () => {
    terminal?.closeAll();
    await attachment?.catch(() => {});
    display.dispose();
    await history?.stop();
    await gateway?.close();
    const exits = children.map((child) =>
      child.exitCode === null && child.signalCode === null
        ? once(child, "exit")
        : Promise.resolve(),
    );
    const force = setTimeout(
      () =>
        children.forEach((child) => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }),
      2000,
    );
    runtime?.close();
    await Promise.all(exits);
    clearTimeout(force);
    await cua?.close();
    await authority?.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  try {
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(data)]);
    await writeFile(path.join(home, "config.toml"), "features.plugins=false\n");
    authority = await createNativeCommandWorkerFixture({
      cwd,
      modelBaseUrl,
      computerUse: options.computerUse,
      ...(options.computerUse
        ? { providerName: "OpenAI", modelName: "gpt-5.6-sol" }
        : {}),
    });
    const f = authority;
    const { chatId, projectId, placementId, ownerId, workerId, serverId } = f;
    const model: Parameters<CodexAppServer["runTurn"]>[0]["model"] =
      f.modelRuntime.model;
    if (options.computerUse)
      model.catalog = {
        nativeModelId: model.name,
        displayName: "Native child CUA fixture",
        description: null,
        contextWindow: 128000,
        maxOutputTokens: null,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: false,
        supportsStructuredOutput: true,
        supportsVision: true,
        supportsReasoning: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        reasoningMandatory: null,
        metadataSource: "manual",
      };
    const provider = { ...f.modelRuntime.provider, apiKey: "fixture-only" };
    runtime = new CodexAppServer(
      binary,
      data,
      home,
      await discoverCodexRuntime(binary, home),
      undefined,
      undefined,
      undefined,
      (executable, args, options) => {
        const child = spawn(executable, args, {
          cwd,
          env: { ...options.env, HOME: home, CODEX_HOME: home },
          stdio: "pipe",
        });
        child.stderr.on("data", (chunk) => {
          nativeStderr += chunk;
        });
        children.push(child);
        return child;
      },
    );
    const r = runtime;
    if (options.computerUse)
      cua = await createNativeCuaWorkerFixture({
        authority: f,
        runtime: r,
        directory: data,
      });
    const identity = {
      serverId,
      ownerId,
      workerId,
      chatId,
      contextKind: "project" as const,
      projectId,
      placementId,
    };
    const configuration = {
      cwd,
      model,
      provider,
      threadId: null,
      permissionProfileId,
      planMode: options.planMode ?? "default",
      executionProfile: "ide" as const,
      mcpServers: [...(cua?.servers ?? []), ...(options.mcpServers ?? [])],
      intent: "configure" as const,
      subagentDefaults: null,
    };
    const prepare = (intent: "configure" | "preserve") =>
      new ManagedSessionCoordinator(
        path.join(data, "managed-sessions"),
      ).prepare({
        identity,
        runtime: r,
        configuration: { ...configuration, intent },
        onThreadIdentified: async (id) => {
          await f.bindThread(id);
        },
      });
    const { threadId } = await prepare("configure");
    const preparedMode = (await r.readNativeThreadSettings(threadId)).confirmed
      ?.settings.collaborationMode.mode;
    const transport = {
      serverUrl: f.serverUrl,
      workerId,
      token: () => f.token,
      fetch: f.fetch,
    };
    const client = new NativeCommandClient(transport);
    const encryption = {
      ownerId: () => ownerId,
      serverIdentity: () => serverId,
      componentKey: (_scope: string, keyRevision = 1) => ({
        keyRevision,
        key: new Uint8Array(32).fill(73),
      }),
    } as WorkerEncryptionService;
    const createAdapter = () =>
      new ManagedNativeCommandSession({
        identity,
        runtime: r,
        client,
        encryption,
        policy: {
          cwd,
          codexHome: home,
          permissionProfileId,
          security: nativePermissionPatch(permissionProfileId),
        },
        onError: (error) => errors.push(error),
        beginExecution: async (grant, session) => {
          const release = cua?.activate(grant, session.threadId!);
          return {
            options: {
              cwd,
              model,
              provider,
              chatId,
              captureProtectedDiagnostics: false,
              ...interactionCallbacks,
              onMessage: (message) => messages.push(message.text),
            },
            complete: async (result) => {
              completed.push(result.turnId!);
            },
            failed: async (error) => {
              turnFailures.push(error);
            },
            release: async () => {
              await release?.();
            },
          };
        },
      });
    let adapter = createAdapter();
    let generation = r.transportGeneration!;
    const session = {
      chatId,
      threadId,
      contextKind: "project" as const,
      projectId,
      placementId,
      runtimeGeneration: generation,
      connectionId: `gui:${generation}`,
      modelRouteId: model.routeId,
      providerAccountId: null,
    };
    r.setManagedNativeCommandDispatcher(threadId, (command) =>
      adapter.executeGuiCommand(session, command),
    );
    const openGateway = async () => {
      const attachedGeneration = generation;
      return createManagedNativeGateway({
        identity: {
          ...identity,
          threadId,
          runtimeGeneration: generation,
          modelRouteId: model.routeId,
          providerAccountId: null,
        },
        upstreamUrl: await r.remoteEndpoint(model, provider),
        isCurrent: () => r.transportGeneration === attachedGeneration,
        onNativeMessage: (frame) => frames.push(frame),
        admit: (operation) => adapter.admit(operation),
        resolveReply: (operation, frame) =>
          adapter.resolveReply(operation, frame),
      });
    };
    gateway = await openGateway();
    const historyClient = new NativeHistoryClient(transport);
    const openHistory = () =>
      new ManagedNativeHistory({
        directory: data,
        workerId,
        service: encryption,
        client: historyClient,
        attachments: new AttachmentStore(data),
        snapshotDelayMs: 0,
        retryDelayMs: 10,
        maxRetryDelayMs: 20,
        onError: (error) => errors.push(error),
      });
    history = openHistory();
    history.bind({ runtime: r, chatId, threadId });
    terminal = new TerminalManager({ environment: { HOME: home } });
    const t = terminal;
    let remoteUrl = gateway.url;
    const openTerminal = () =>
      t
        .open(
          "shared-tui",
          "view",
          cwd,
          130,
          45,
          {
            type: "codex",
            binary,
            codexHome: home,
            remoteUrl,
            threadId,
            model,
            provider,
            session: {
              chatId,
              contextKind: "project",
              projectId,
              worktreeId: placementId,
              rootKind: "git-worktree",
              scratchRootId: null,
              computerUseEnabled: options.computerUse === true,
            },
          },
          (event) => {
            if (event.type !== "terminal.output") return;
            terminalOutput += event.data;
            display.write(event.data);
            try {
              if (event.data.includes("\x1b[6n"))
                t.input("shared-tui", "\x1b[1;1R");
              if (event.data.includes("\x1b[c"))
                t.input("shared-tui", "\x1b[?1;2c");
              if (event.data.includes("\x1b]10;?"))
                t.input("shared-tui", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
              if (event.data.includes("\x1b]11;?"))
                t.input("shared-tui", "\x1b]11;rgb:0000/0000/0000\x1b\\");
            } catch {
              /* Final capability query during teardown. */
            }
          },
        )
        .finally(() => {
          terminalSettled = true;
        });
    attachment = openTerminal();
    void attachment.catch((error) => errors.push(error));
    await vi.waitFor(
      () => {
        const resume = f.phases.find(
          (entry) =>
            entry.phase === "admit" && entry.body.method === "thread/resume",
        );
        expect(resume).toBeDefined();
        expect(f.receipts.get(resume!.body.operationId)?.status).toBe(
          "applied",
        );
        expect(stripVTControlCharacters(terminalOutput)).toContain(model.name);
      },
      { timeout: 15000 },
    );
    const attachedMode = (await r.readNativeThreadSettings(threadId)).confirmed
      ?.settings.collaborationMode.mode;
    return {
      authority: f,
      runtime: r,
      threadId,
      get generation() {
        return generation;
      },
      frames,
      messages,
      completed,
      errors,
      children,
      historyClient,
      cua,
      turnFailures,
      interactionRequests,
      interactionCleared,
      interactionExpired,
      preparedMode,
      attachedMode,
      async restartRuntime(afterExit?: () => Promise<void>) {
        const oldGeneration = generation;
        const oldSession = { ...session };
        const oldAdapter = adapter;
        const process = children.at(-1)!;
        expect(process.exitCode).toBeNull();
        expect(process.signalCode).toBeNull();
        t.close("shared-tui");
        await attachment;
        await gateway!.close();
        await history!.stop();
        const exited = once(process, "exit");
        expect(process.kill("SIGKILL")).toBe(true);
        await exited;
        await vi.waitFor(() => expect(r.transportGeneration).toBeNull());
        await afterExit?.();
        const restored = await prepare("preserve");
        expect(restored.threadId).toBe(threadId);
        generation = r.transportGeneration!;
        expect(generation).not.toBe(oldGeneration);
        session.runtimeGeneration = generation;
        session.connectionId = `gui:${generation}`;
        adapter = createAdapter();
        r.setManagedNativeCommandDispatcher(threadId, (command) =>
          adapter.executeGuiCommand(session, command),
        );
        gateway = await openGateway();
        remoteUrl = gateway.url;
        history = openHistory();
        history.bind({ runtime: r, chatId, threadId });
        terminalOutput = "";
        display.reset();
        terminalSettled = false;
        attachment = openTerminal();
        void attachment.catch((error) => errors.push(error));
        await vi.waitFor(
          () => {
            const resumes = f.phases.filter(
              (entry) =>
                entry.phase === "admit" &&
                entry.body.method === "thread/resume" &&
                entry.body.session.runtimeGeneration === generation,
            );
            expect(resumes).toHaveLength(1);
            expect(f.receipts.get(resumes[0]!.body.operationId)?.status).toBe(
              "applied",
            );
            expect(terminalText()).toContain(model.name);
          },
          { timeout: 15000 },
        );
        await history.flush();
        return { oldGeneration, oldSession, oldAdapter };
      },
      restartTerminal: async (startupInput = "") => {
        const resumes = f.phases.filter(
          (entry) =>
            entry.phase === "admit" && entry.body.method === "thread/resume",
        ).length;
        t.close("shared-tui");
        await attachment;
        terminalOutput = "";
        display.reset();
        terminalSettled = false;
        attachment = openTerminal();
        void attachment.catch((error) => errors.push(error));
        if (startupInput) t.input("shared-tui", startupInput);
        await vi.waitFor(
          () => {
            const applied = f.phases.filter(
              (entry) =>
                entry.phase === "admit" &&
                entry.body.method === "thread/resume" &&
                f.receipts.get(entry.body.operationId)?.status === "applied",
            );
            expect(applied).toHaveLength(resumes + 1);
            expect(terminalText()).toContain(model.name);
          },
          { timeout: 15000 },
        );
      },
      tuiInput: (data: string) => t.input("shared-tui", data),
      guiStop: () => r.interruptChat(chatId, threadId),
      tuiStop: () => t.input("shared-tui", "\x03"),
      terminalText,
      terminalSettled: () => terminalSettled,
      diagnostics: () => ({
        preparedMode,
        attachedMode,
        terminal: stripVTControlCharacters(terminalOutput).slice(-4000),
        stderr: nativeStderr.slice(-3000),
        errors: [...new Set(errors.map(String))],
        turnFailures: turnFailures.map(String),
        childEvents: frames
          .filter((frame) =>
            [
              "thread/started",
              "turn/started",
              "item/started",
              "item/completed",
            ].includes(frame.method),
          )
          .map((frame) => ({
            method: frame.method,
            thread: frame.params.threadId ?? frame.params.thread?.id,
            parent: frame.params.thread?.source,
            type: frame.params.item?.type,
            receiver: frame.params.item?.receiverThreadIds,
          })),
        frames: frames
          .filter((frame) => frame.error || frame.method?.startsWith("turn/"))
          .slice(-15),
        phases: f.phases.map(({ phase, status, code, body }) => ({
          phase,
          status,
          code,
          method: body.method,
          operationId: body.operationId,
        })),
      }),
      async tuiSend(text: string) {
        t.input("shared-tui", text);
        await vi.waitFor(() => expect(terminalText()).toContain(text), {
          timeout: 5000,
        });
        t.input("shared-tui", "\r");
      },
      async guiStart(prompt: string) {
        const clientMessageId = randomUUID();
        const classification = {
          role: "user" as const,
          mode: "default" as const,
          attachmentIds: [] as string[],
        };
        const protectedInput = {
          id: clientMessageId,
          classification,
          idempotencyKey: `gui-input:${clientMessageId}`,
          reasoningEffort: null,
          protectedContent: await encryptChatMessageProtectedContent({
            ownerId,
            messageId: clientMessageId,
            keyRevision: 1,
            componentKey: new Uint8Array(32).fill(73),
            content: {
              version: 1,
              classification,
              content: [{ type: "text", text: prompt }],
            },
          }),
        };
        expect(
          await f.repository.appendEncryptedMessage(
            ownerId,
            chatId,
            protectedInput,
          ),
        ).not.toBeNull();
        // Use the real GUI server admission entry so its logical input ID is
        // bound to the saved encrypted message before native execution starts.
        const { nativeCommandReceipt: receipt, execution } =
          await acquireChatTurnExecution({
            repository: f.repository,
            ownerId,
            context: (await f.repository.getChatExecutionContext(
              ownerId,
              chatId,
            ))!,
            options: {},
            protectedAdmissionInput: protectedInput,
            observeTaskTurnBootstrapStage: (_stage, run) => run(),
          });
        expect(receipt?.status).toBe("accepted");
        if (!receipt)
          throw new Error("GUI admission returned no native receipt.");
        const guiSession = {
          ...session,
          connectionId: `gui:${receipt.operationGeneration}`,
        };
        let releaseCua: (() => Promise<void>) | undefined;
        const run = adapter.withGuiPreparation(receipt, guiSession, () =>
          r.runTurn({
            operationGeneration: receipt.operationGeneration,
            chatId,
            threadId,
            cwd,
            model,
            provider,
            captureProtectedDiagnostics: false,
            clientMessageId,
            executionProfile: "ide",
            isPrimary: true,
            automationPaused: false,
            planMode: options.planMode ?? "default",
            policyContext: null,
            permissionProfileId,
            prompt,
            mcpServers: [
              ...(cua?.servers ?? []),
              ...(options.mcpServers ?? []),
            ],
            rootKind: f.context.rootKind,
            skillNames: [],
            subagentDefaults: null,
            subagentProtocolVersion: undefined,
            worktreeMode: f.context.worktreeMode,
            worktreePolicy: f.context.worktreePolicy,
            onThreadLoaded: (id) => {
              if (cua)
                releaseCua = cua.activate(
                  {
                    receipt,
                    computerUseAuthority: {
                      ...computerUsePreviewAuthority({
                        context: execution,
                        ownerId,
                        serverId,
                      }),
                      executionLaneId: receipt.executionLaneId!,
                    },
                  },
                  id,
                );
            },
            onBeforeNativeDispatch: () =>
              adapter.dispatchGui(receipt, guiSession, receipt),
            onNativeReceipt: (result) =>
              adapter.guiReceipt(receipt, guiSession, result),
            ...interactionCallbacks,
            onMessage: (message) => messages.push(message.text),
          }),
        );
        const settled = run.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        return {
          settled,
          clientMessageId,
          originalInput: protectedInput,
          async finish(status: "idle" | "failed" = "idle") {
            await releaseCua?.();
            adapter.markGuiFinished(
              receipt.operationId,
              receipt.operationGeneration,
            );
            expect(
              await f.repository.nativeCommands.finishLogicalGui(
                ownerId,
                workerId,
                receipt.operationId,
                receipt.operationGeneration,
                status,
              ),
            ).toBe(true);
            adapter.completeGuiLogical(
              receipt.operationId,
              receipt.operationGeneration,
            );
          },
        };
      },
      guiSteer: (prompt: string) =>
        r.steerThread(chatId, threadId, prompt, [], model, provider),
      flushHistory: () => history!.flush(),
      async reopenHistory() {
        await history!.stop();
        history = openHistory();
        history.bind({ runtime: r, chatId, threadId });
        await history.flush();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
