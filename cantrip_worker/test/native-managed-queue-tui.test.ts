import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import {
  CodexAppServer,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../src/codex/managed-native-gateway.js";
import { ManagedNativeCommandSession } from "../src/codex/managed-native-command-session.js";
import { ManagedNativeQueue } from "../src/codex/managed-native-queue.js";
import { ManagedNativeQueueClient } from "../src/managed-native-queue-client.js";
import { NativeCommandClient } from "../src/native-command-client.js";
import { createManagedQueueInputCodec } from "../src/managed-queue-input.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { TerminalManager } from "../src/terminal-manager.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Frame = Record<string, any>;

/** Drop a real committed delete reply, then permit normal reconnects. */
async function lostDeleteAckProxy(endpoint: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const sockets = new Set<WebSocket>();
  let dropped = false;
  let connections = 0;
  server.on("connection", (downstream) => {
    connections++;
    const upstream = new WebSocket(endpoint);
    sockets.add(downstream);
    sockets.add(upstream);
    const methods = new Map<string | number, string>();
    const queued: string[] = [];
    downstream.on("message", (raw) => {
      const text = raw.toString();
      const frame = JSON.parse(text) as Frame;
      if (frame.id !== undefined && typeof frame.method === "string")
        methods.set(frame.id, frame.method);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queued.push(text);
    });
    upstream.on("open", () => {
      for (const text of queued) upstream.send(text);
      queued.length = 0;
    });
    upstream.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (
        !dropped &&
        methods.get(frame.id) === "thread/queue/delete" &&
        frame.result?.deleted === true
      ) {
        dropped = true;
        downstream.terminate();
        upstream.terminate();
        return;
      }
      if (downstream.readyState === WebSocket.OPEN)
        downstream.send(raw.toString());
    });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.terminate());
    upstream.on("error", () => downstream.terminate());
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    dropped: () => dropped,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Real PTY, pinned native engine, authenticated gateway and canonical PGlite queue.
 * This case tests queue editing; it intentionally supplies no execution dispatcher. */
describe.skipIf(!binary || process.platform === "win32")(
  "native managed shared queue TUI",
  () => {
    it("uses canonical IDs for edits and reconciles a lost delete ACK after reconnect without locally draining", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-native-queue-tui-"),
      );
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "workspace");
      const data = path.join(directory, "runtime");
      const children: ChildProcessWithoutNullStreams[] = [];
      const modelRequests: string[] = [];
      const modelServer = createServer((request, response) => {
        modelRequests.push(request.url ?? "");
        response.writeHead(500).end("Queue editing cannot invoke inference.");
      });
      let authority:
        | Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>
        | undefined;
      let runtime: CodexAppServer | undefined;
      let gateway: ManagedNativeGateway | undefined;
      let proxy: Awaited<ReturnType<typeof lostDeleteAckProxy>> | undefined;
      let manager: TerminalManager | undefined;
      let output = "";
      const operations: Array<{
        method: string;
        params: Frame;
        result?: Frame;
        error?: string;
      }> = [];
      const errors: unknown[] = [];
      const nativeFrames: Frame[] = [];
      try {
        await Promise.all([mkdir(home), mkdir(cwd), mkdir(data)]);
        await writeFile(
          path.join(home, "config.toml"),
          "features.plugins=false\n",
        );
        modelServer.listen(0, "127.0.0.1");
        await once(modelServer, "listening");
        const baseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
        authority = await createNativeCommandWorkerFixture({
          cwd,
          modelBaseUrl: baseUrl,
        });
        const model = authority.modelRuntime.model;
        const provider = {
          ...authority.modelRuntime.provider,
          apiKey: "fixture-only",
        };
        const launch: CodexProcessLauncher = (executable, args, options) => {
          const child = spawn(executable, args, {
            cwd,
            env: { ...options.env, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          children.push(child);
          return child;
        };
        runtime = new CodexAppServer(
          binary!,
          data,
          home,
          await discoverCodexRuntime(binary!, home),
          undefined,
          undefined,
          undefined,
          launch,
        );
        const threadId = await runtime.prepareManagedThread({
          cwd,
          model,
          provider,
          threadId: null,
          permissionProfileId: ":workspace",
          planMode: "default",
          executionProfile: "ide",
          mcpServers: [],
          intent: "configure",
          onThreadIdentified: (id) => authority!.bindThread(id).then(() => {}),
        });
        const nativeThreadId = threadId.threadId;
        const identity = {
          serverId: authority.serverId,
          ownerId: authority.ownerId,
          workerId: authority.workerId,
          chatId: authority.chatId,
          contextKind: "project" as const,
          projectId: authority.projectId,
          placementId: authority.placementId,
          threadId: nativeThreadId,
          runtimeGeneration: runtime.transportGeneration!,
          modelRouteId: model.routeId,
          providerAccountId: null,
        };
        const encryption = {
          ownerId: () => authority!.ownerId,
          serverIdentity: () => authority!.serverId,
          componentKey: (_scope: string, revision = 1) => ({
            key: new Uint8Array(32).fill(73),
            keyRevision: revision,
          }),
        } as WorkerEncryptionService;
        const clientOptions = {
          serverUrl: authority.serverUrl,
          workerId: authority.workerId,
          token: () => authority!.token,
          fetch: authority.fetch,
        };
        const policy = {
          cwd,
          codexHome: home,
          permissionProfileId: ":workspace",
          security: {
            permissions: ":workspace",
            approvalPolicy: "on-request" as const,
            approvalsReviewer: "user" as const,
          },
        };
        const adapter = new ManagedNativeCommandSession({
          identity,
          runtime,
          encryption,
          policy,
          client: new NativeCommandClient(clientOptions),
          onError: (error) => errors.push(error),
          beginExecution: async () => {
            throw new Error(
              "The queue editing fixture cannot start execution.",
            );
          },
        });
        const queueClient = new ManagedNativeQueueClient(clientOptions);
        const codec = createManagedQueueInputCodec({
          encryption,
          chatId: authority.chatId,
          defaults: () => ({
            mode: "default",
            modelId: model.id,
            reasoningEffort: null,
            worktreeId: authority!.placementId,
          }),
        });
        const queue = new ManagedNativeQueue({
          identity,
          client: queueClient,
          encryption,
          policy,
          currentActivationGeneration: () => null,
          preparePrompt: codec.preparePrompt,
          openPrompt: codec.openPrompt,
        });
        gateway = await createManagedNativeGateway({
          identity,
          upstreamUrl: await runtime.remoteEndpoint(model, provider),
          onNativeMessage: (frame) => nativeFrames.push(frame),
          isCurrent: () =>
            runtime!.transportGeneration === identity.runtimeGeneration,
          admit: (operation) => adapter.admit(operation),
          resolveReply: (operation, frame) =>
            adapter.resolveReply(operation, frame),
          queue: {
            subscribe: (listener) => queue.subscribe(listener),
            execute: async (request) => {
              const observed = {
                method: request.method,
                params: structuredClone(request.params),
              } as (typeof operations)[number];
              operations.push(observed);
              try {
                return (observed.result = await queue.execute(request));
              } catch (error) {
                observed.error = String(error);
                throw error;
              }
            },
          },
        });
        proxy = await lostDeleteAckProxy(gateway.url);
        manager = new TerminalManager({ environment: { HOME: home } });
        const terminalId = "canonical-queue";
        const exited = manager.open(
          terminalId,
          "canonical-queue",
          cwd,
          130,
          45,
          {
            type: "codex",
            binary: binary!,
            codexHome: home,
            remoteUrl: proxy.url,
            threadId: nativeThreadId,
            model,
            provider,
            session: {
              chatId: authority.chatId,
              contextKind: "project",
              projectId: authority.projectId,
              worktreeId: authority.placementId,
              rootKind: "git-worktree",
              scratchRootId: null,
              computerUseEnabled: false,
            },
          },
          (event) => {
            if (event.type !== "terminal.output") return;
            output += event.data;
            if (event.data.includes("\x1b[6n"))
              manager!.input(terminalId, "\x1b[1;1R");
            if (event.data.includes("\x1b[c"))
              manager!.input(terminalId, "\x1b[?1;2c");
            if (event.data.includes("\x1b]10;?"))
              manager!.input(terminalId, "\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
            if (event.data.includes("\x1b]11;?"))
              manager!.input(terminalId, "\x1b]11;rgb:0000/0000/0000\x1b\\");
          },
        );
        void exited.catch((error) => errors.push(error));
        const diagnostic = () =>
          JSON.stringify({
            tail: stripVTControlCharacters(output).slice(-3500),
            operations,
            phases: authority!.phases.map(({ phase, status, code, body }) => ({
              phase,
              status,
              code,
              method: body.admission?.method ?? body.method,
              operationId: body.admission?.operationId ?? body.operationId,
            })),
            errors: errors.map(String),
          });
        const waitFor = (check: () => void) =>
          vi.waitFor(check, { timeout: 15000 });
        const completed = (method: string) =>
          operations.filter((op) => op.method === method && op.result);
        const waitOperation = (method: string, count: number) =>
          waitFor(() =>
            expect(completed(method).length, diagnostic()).toBe(count),
          );
        const keys = (text: string) => manager!.input(terminalId, text);
        await waitFor(() =>
          expect(
            completed("thread/queue/list").length,
            diagnostic(),
          ).toBeGreaterThan(0),
        );
        await waitFor(() =>
          expect(
            nativeFrames.some(
              (frame) => frame.result?.thread?.id === nativeThreadId,
            ),
            diagnostic(),
          ).toBe(true),
        );
        for (const [index, text] of [
          "first canonical draft",
          "second canonical draft",
        ].entries()) {
          keys(text);
          keys("\t");
          await waitOperation("thread/queue/add", index + 1);
          await waitFor(() =>
            expect(
              operations.some(
                (op) =>
                  op.method === "thread/queue/list" &&
                  op.result?.data?.length === index + 1,
              ),
              diagnostic(),
            ).toBe(true),
          );
        }
        const added = completed("thread/queue/add").map(
          (op) => op.result!.queuedSubmission,
        );
        expect(added.map((item) => item.id)).toHaveLength(2);
        expect(new Set(added.map((item) => item.id)).size).toBe(2);
        const keyThenView = async (input: string, label: string) => {
          const offset = output.length;
          keys(input);
          await waitFor(() =>
            expect(
              stripVTControlCharacters(output.slice(offset)),
              diagnostic(),
            ).toContain(label),
          );
        };
        const openFirst = async () => {
          await keyThenView("\x11", "Shared queue");
          await keyThenView("\r", "Edit text");
        };
        // Open canonical picker, choose first item, then move it below its sibling.
        await openFirst();
        keys("\x1b[B\x1b[B\x1b[B\r");
        await waitOperation("thread/queue/reorder", 1);
        expect(
          completed("thread/queue/reorder")[0]!.params.queuedSubmissionIds,
        ).toEqual([added[1].id, added[0].id]);
        await waitFor(() =>
          expect(
            operations.some(
              (op) =>
                op.method === "thread/queue/list" &&
                op.result?.data?.[0]?.id === added[1].id,
            ),
            diagnostic(),
          ).toBe(true),
        );
        // Select the first item after reorder and edit its text through the real prompt view.
        await openFirst();
        await keyThenView("\r", "Edit shared queued text");
        // Real terminals bracket pasted text. A text+Enter byte burst is
        // intentionally a multiline paste in native CustomPromptView.
        await keyThenView(
          "\x01\x0b\x1b[200~changed canonical draft\x1b[201~",
          "changed canonical draft",
        );
        keys("\r");
        await waitOperation("thread/queue/update", 1);
        expect(
          completed("thread/queue/update")[0]!.params.queuedSubmissionId,
        ).toBe(added[1].id);
        expect(completed("thread/queue/update")[0]!.params.input[0].text).toBe(
          "changed canonical draft",
        );
        await waitFor(() =>
          expect(
            operations.some(
              (op) =>
                op.method === "thread/queue/list" &&
                op.result?.data?.[0]?.input?.[0]?.text ===
                  "changed canonical draft",
            ),
            diagnostic(),
          ).toBe(true),
        );
        await openFirst();
        keys("\x1b[B\r");
        await waitOperation("thread/queue/delete", 1);
        expect(
          completed("thread/queue/delete")[0]!.params.queuedSubmissionId,
        ).toBe(added[1].id);
        await waitFor(() => expect(proxy!.dropped(), diagnostic()).toBe(true));
        await waitFor(() =>
          expect(proxy!.connections(), diagnostic()).toBeGreaterThan(1),
        );
        await waitFor(() =>
          expect(
            nativeFrames.filter(
              (frame) => frame.result?.thread?.id === nativeThreadId,
            ).length,
            diagnostic(),
          ).toBeGreaterThan(1),
        );
        // A native resume receipt precedes the TUI's reconnect restoration.
        // Wait for its actual user-visible readiness before sending a new key.
        await waitFor(() =>
          expect(stripVTControlCharacters(output), diagnostic()).toContain(
            "Reconnected. No input was resent.",
          ),
        );
        // The real TUI retains the original operation across transport loss.
        await keyThenView("\x11", "Retry unacknowledged thread/queue/delete");
        keys("\x1b[B\r");
        await waitOperation("thread/queue/delete", 2);
        expect(completed("thread/queue/delete")[1]!.params).toEqual(
          completed("thread/queue/delete")[0]!.params,
        );
        expect(modelRequests).toEqual([]);
        expect(
          operations.filter((op) => op.method === "thread/queue/start"),
        ).toEqual([]);
        expect(
          authority.phases.filter((phase) => phase.status >= 400),
          diagnostic(),
        ).toEqual([]);
      } finally {
        manager?.close("canonical-queue");
        await proxy?.close();
        await gateway?.close();
        runtime?.close();
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            child.kill("SIGTERM");
            await closed;
          }
        }
        modelServer.closeAllConnections();
        await new Promise<void>((resolve) =>
          modelServer.close(() => resolve()),
        );
        await authority?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
