import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encryptChatMessageProtectedContent } from "@cantrip/crypto";
import { acquireChatTurnExecution } from "../../cantrip_server/src/app/runtime/chat-turn-admission.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import { CodexAppServer } from "../src/codex/app-server.js";
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

/** Actual engine, physical TUI, admitted GUI commands, and encrypted server history.
 * Provider responses are supplied by the caller; native RPC is never mocked. */
export async function createNativeSharedViewFixture(
  binary: string,
  modelBaseUrl: string,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-shared-view-"));
  const cwd = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  const data = path.join(directory, "data");
  const children: ChildProcessWithoutNullStreams[] = [];
  const errors: unknown[] = [];
  const messages: string[] = [];
  const completed: string[] = [];
  const frames: Record<string, any>[] = [];
  let terminalOutput = "";
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
    authority = await createNativeCommandWorkerFixture({ cwd, modelBaseUrl });
    const f = authority;
    const { chatId, projectId, placementId, ownerId, workerId, serverId } = f;
    const model = f.modelRuntime.model;
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
    const identity = {
      serverId,
      ownerId,
      workerId,
      chatId,
      contextKind: "project" as const,
      projectId,
      placementId,
    };
    const { threadId } = await new ManagedSessionCoordinator(
      path.join(data, "managed-sessions"),
    ).prepare({
      identity,
      runtime: r,
      configuration: {
        cwd,
        model,
        provider,
        threadId: null,
        permissionProfileId: ":workspace",
        planMode: "default",
        executionProfile: "ide",
        mcpServers: [],
        intent: "configure",
        subagentDefaults: null,
      },
      onThreadIdentified: async (id) => {
        await f.bindThread(id);
      },
    });
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
    const adapter = new ManagedNativeCommandSession({
      identity,
      runtime: r,
      client,
      encryption,
      policy: {
        cwd,
        codexHome: home,
        permissionProfileId: ":workspace",
        security: {
          permissions: ":workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
      },
      onError: (error) => errors.push(error),
      beginExecution: async () => ({
        options: {
          cwd,
          model,
          provider,
          chatId,
          captureProtectedDiagnostics: false,
          onMessage: (message) => messages.push(message.text),
        },
        complete: async (result) => {
          completed.push(result.turnId!);
        },
        failed: async (error) => {
          errors.push(error);
        },
        release: async () => {},
      }),
    });
    const generation = r.transportGeneration!;
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
    gateway = await createManagedNativeGateway({
      identity: {
        ...identity,
        threadId,
        runtimeGeneration: generation,
        modelRouteId: model.routeId,
        providerAccountId: null,
      },
      upstreamUrl: await r.remoteEndpoint(model, provider),
      isCurrent: () => r.transportGeneration === generation,
      onNativeMessage: (frame) => frames.push(frame),
      admit: (operation) => adapter.admit(operation),
      resolveReply: (operation, frame) =>
        adapter.resolveReply(operation, frame),
    });
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
    attachment = t
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
          remoteUrl: gateway.url,
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
            computerUseEnabled: false,
          },
        },
        (event) => {
          if (event.type !== "terminal.output") return;
          terminalOutput += event.data;
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
    return {
      authority: f,
      runtime: r,
      threadId,
      generation,
      frames,
      messages,
      completed,
      errors,
      children,
      historyClient,
      terminalText: () => stripVTControlCharacters(terminalOutput),
      terminalSettled: () => terminalSettled,
      diagnostics: () => ({
        terminal: stripVTControlCharacters(terminalOutput).slice(-4000),
        stderr: nativeStderr.slice(-3000),
        errors: errors.map(String),
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
        await vi.waitFor(
          () =>
            expect(stripVTControlCharacters(terminalOutput)).toContain(text),
          { timeout: 5000 },
        );
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
        const { nativeCommandReceipt: receipt } =
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
            planMode: "default",
            policyContext: null,
            permissionProfileId: ":workspace",
            prompt,
            mcpServers: [],
            rootKind: f.context.rootKind,
            skillNames: [],
            subagentDefaults: null,
            subagentProtocolVersion: undefined,
            worktreeMode: f.context.worktreeMode,
            worktreePolicy: f.context.worktreePolicy,
            onBeforeNativeDispatch: () =>
              adapter.dispatchGui(receipt, guiSession, receipt),
            onNativeReceipt: (result) =>
              adapter.guiReceipt(receipt, guiSession, result),
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
          async finish() {
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
                "idle",
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
