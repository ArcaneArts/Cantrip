import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import * as schema from "../../cantrip_server/src/db/schema.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { ManagedNativeHistory } from "../src/managed-native-history.js";
import { NativeHistoryClient } from "../src/native-history-client.js";
import { AttachmentStore } from "../src/attachment-store.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)(
  "worker history lifecycle with the pinned native runtime",
  () => {
    it("publishes GUI-entry and remote-client turns, retries a lost receipt and recovers without a new native turn", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-native-projection-"),
      );
      const cwd = path.join(directory, "workspace");
      const home = path.join(directory, "home");
      const data = path.join(directory, "data");
      const children: ChildProcessWithoutNullStreams[] = [];
      const requests: unknown[] = [];
      let spawnIssued = false;
      let releaseChild!: () => void;
      const childRelease = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      const provider = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        requests.push(payload);
        const n = requests.length;
        const isChild =
          JSON.stringify(payload.input).includes("SHARED_HISTORY_CHILD") &&
          !JSON.stringify(payload.input).includes("SHARED_HISTORY_PARENT");
        if (isChild) await childRelease;
        const spawnTool =
          !spawnIssued &&
          JSON.stringify(payload.input).includes("SHARED_HISTORY_PARENT")
            ? payload.tools?.find((tool: any) =>
                tool.name?.endsWith("spawn_agent"),
              )
            : null;
        if (spawnTool) spawnIssued = true;
        const fields = spawnTool?.parameters?.properties ?? {};
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: `response-${n}` } },
          {
            type: "response.output_item.done",
            item: spawnTool
              ? {
                  type: "function_call",
                  id: "spawn-history-child",
                  call_id: "history-child-call",
                  name: spawnTool.name,
                  arguments: JSON.stringify({
                    message: "SHARED_HISTORY_CHILD: answer briefly.",
                    ...(fields.task_name
                      ? { task_name: "shared_history_child" }
                      : {}),
                    ...(fields.fork_turns ? { fork_turns: "none" } : {}),
                    ...(fields.fork_context ? { fork_context: false } : {}),
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: `answer-${n}`,
                  content: [
                    {
                      type: "output_text",
                      text: isChild
                        ? "native child answer"
                        : `native answer ${n}`,
                    },
                  ],
                },
          },
          {
            type: "response.completed",
            response: {
              id: `response-${n}`,
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          },
        ])
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        response.end();
      });
      let f:
        | Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>
        | undefined;
      let runtime: CodexAppServer | undefined;
      let history: ManagedNativeHistory | undefined;
      let socket: WebSocket | undefined;
      const errors: unknown[] = [];
      try {
        await Promise.all([mkdir(cwd), mkdir(home), mkdir(data)]);
        const catalog = JSON.parse(
          await readFile(
            new URL(
              "../../cantrip_codex/upstream/codex-rs/models-manager/models.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const modelCatalog = path.join(home, "history-models.json");
        await writeFile(
          modelCatalog,
          JSON.stringify({
            models: [
              {
                ...catalog.models[0],
                slug: "gpt-5",
                multi_agent_version: "v2",
                tool_mode: null,
                use_responses_lite: false,
                supports_search_tool: false,
                upgrade: null,
              },
            ],
          }),
        );
        await writeFile(
          path.join(home, "config.toml"),
          `features.plugins=false\nmodel_catalog_json=${JSON.stringify(modelCatalog)}\n`,
        );
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        f = await createNativeCommandWorkerFixture({
          cwd,
          modelBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        });
        const model = f.modelRuntime.model;
        const runtimeProvider = {
          ...f.modelRuntime.provider,
          apiKey: "fixture-only",
        };
        runtime = new CodexAppServer(
          binary!,
          data,
          home,
          await discoverCodexRuntime(binary!, home),
          undefined,
          undefined,
          undefined,
          (executable, args, options) => {
            const child = spawn(executable, args, {
              cwd,
              env: { ...options.env, HOME: home, CODEX_HOME: home },
              stdio: "pipe",
            });
            children.push(child);
            child.stderr.resume();
            return child;
          },
        );
        const configuration = {
          cwd,
          model,
          provider: runtimeProvider,
          threadId: null,
          permissionProfileId: ":workspace",
          planMode: "default" as const,
          executionProfile: "ide" as const,
          mcpServers: [],
          intent: "configure" as const,
          onThreadIdentified: async (id: string) => {
            await f!.bindThread(id);
          },
        };
        const { threadId } = await runtime.prepareManagedThread(configuration);
        const service = {
          ownerId: () => f!.ownerId,
          serverIdentity: () => f!.serverId,
          componentKey: (_scope: string, keyRevision = 1) => ({
            key: new Uint8Array(32).fill(47),
            keyRevision,
          }),
        } as WorkerEncryptionService;
        const client = new NativeHistoryClient({
          serverUrl: await f.app.listen({ port: 0, host: "127.0.0.1" }),
          workerId: f.workerId,
          token: () => f!.token,
        });
        const actualDeliver = client.deliver.bind(client);
        const deliver = vi
          .spyOn(client, "deliver")
          .mockImplementationOnce(async (...args) => {
            await actualDeliver(...args);
            throw new Error("fixture lost committed reply");
          })
          .mockImplementation(actualDeliver);
        const open = () =>
          new ManagedNativeHistory({
            directory: data,
            workerId: f!.workerId,
            service,
            client,
            attachments: new AttachmentStore(data),
            retryDelayMs: 10,
            maxRetryDelayMs: 20,
            snapshotDelayMs: 0,
            onError: (error) => errors.push(error),
          });
        history = open();
        const binding = { runtime, chatId: f.chatId, threadId };
        expect(history.bind(binding)).toBe(history.bind(binding));
        await runtime.runTurn({
          chatId: f.chatId,
          captureProtectedDiagnostics: false,
          clientMessageId: randomUUID(),
          // No fabricated admitted GUI alias: this fixture exercises the real GUI
          // runtime entry with an independent native input identity.
          nativeClientUserMessageId: randomUUID(),
          nativeInput: [
            { type: "text", text: "GUI entry fixture", text_elements: [] },
            {
              type: "image",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=",
            },
          ],
          cwd,
          executionProfile: "ide",
          isPrimary: true,
          model,
          provider: runtimeProvider,
          planMode: "default",
          prompt: "GUI entry fixture",
          skillNames: [],
          threadId,
          worktreeMode: "agent-managed",
          worktreePolicy: "required-for-writes",
          automationPaused: false,
          permissionProfileId: ":workspace",
          policyContext: null,
          rootKind: "git-worktree",
          subagentDefaults: null,
          subagentProtocolVersion: undefined,
        });
        await history.flush();
        expect(deliver.mock.calls[1]![1]).toEqual(deliver.mock.calls[0]![1]);
        expect(deliver.mock.calls[1]![2]).toEqual(deliver.mock.calls[0]![2]);

        const endpoint = await runtime.remoteEndpoint(
          model,
          runtimeProvider,
          configuration,
        );
        socket = new WebSocket(endpoint);
        await once(socket, "open");
        let nextId = 0;
        const call = (method: string, params: unknown) =>
          new Promise<any>((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              socket!.off("message", receive);
              reject(new Error(`Fixture RPC timeout: ${method}`));
            }, 15_000);
            const receive = (raw: WebSocket.RawData) => {
              const frame = JSON.parse(raw.toString());
              if (frame.id !== id) return;
              clearTimeout(timer);
              socket!.off("message", receive);
              if (frame.error) reject(new Error(JSON.stringify(frame.error)));
              else resolve(frame.result);
            };
            socket!.on("message", receive);
            socket!.send(JSON.stringify({ id, method, params }));
          });
        await call("initialize", {
          clientInfo: { name: "history_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        socket.send(JSON.stringify({ method: "initialized" }));
        await call("thread/resume", { threadId });
        const remote = await call("turn/start", {
          threadId,
          input: [
            { type: "text", text: "Remote client fixture", text_elements: [] },
          ],
        });
        await vi.waitFor(
          async () => {
            const result = await call("thread/read", {
              threadId,
              includeTurns: true,
            });
            expect(
              result.thread.turns.find(
                (turn: any) => turn.id === remote.turn.id,
              )?.status,
            ).toBe("completed");
          },
          { timeout: 15_000 },
        );
        // A real native tool-origin turn emits FunctionCallOutput via the pinned
        // app-server, then follows the same capture/encryption/HTTP ingestion path.
        const toolTurn = await call("turn/start", {
          threadId,
          input: [],
          toolOutput: {
            name: "display_fixture",
            namespace: "history_test",
            output: [
              {
                type: "input_text",
                text: "  exact tool output\n".repeat(2_000),
              },
              {
                type: "input_image",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=",
              },
              { type: "input_text", text: "after image" },
            ],
          },
        });
        await vi.waitFor(
          async () => {
            const result = await call("thread/read", {
              threadId,
              includeTurns: true,
            });
            expect(
              result.thread.turns.find(
                (turn: any) => turn.id === toolTurn.turn.id,
              )?.status,
            ).toBe("completed");
          },
          { timeout: 15_000 },
        );
        // Exercise history with explicit native V2 model metadata and session
        // configuration. This does not establish model-catalog/default parity.
        await call("thread/managedConfig/update", {
          threadId,
          mcpServers: {},
          developerInstructions: null,
          multiAgentEnabled: true,
          subagentModel: null,
          subagentReasoningEffort: null,
          canonicalHistory: true,
        });
        const parentTurn = await call("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: "SHARED_HISTORY_PARENT: spawn the child.",
              text_elements: [],
            },
          ],
        });
        let childThreadId: string | undefined;
        await vi.waitFor(
          async () => {
            const result = await call("thread/read", {
              threadId,
              includeTurns: true,
            });
            const parent = result.thread.turns.find(
              (turn: any) => turn.id === parentTurn.turn.id,
            );
            expect(parent?.status).toBe("completed");
            childThreadId = parent?.items.find(
              (item: any) =>
                item.type === "subAgentActivity" && item.kind === "started",
            )?.agentThreadId;
            expect(childThreadId).toBeTruthy();
          },
          { timeout: 15_000 },
        );
        // Let automatic discovery settle while the child is still generating.
        // A completed parent must not retire the child's observation lifetime.
        await history.flush();
        releaseChild();
        await vi.waitFor(
          async () => {
            const result = await call("thread/read", {
              threadId: childThreadId,
              includeTurns: true,
            });
            expect(result.thread.turns.at(-1)?.status).toBe("completed");
            const parent = await call("thread/read", {
              threadId,
              includeTurns: true,
            });
            expect(
              parent.thread.turns
                .find((turn: any) => turn.id === parentTurn.turn.id)
                ?.items.some(
                  (item: any) =>
                    item.type === "subAgentActivity" &&
                    item.kind === "completed" &&
                    item.agentThreadId === childThreadId,
                ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        await history.flush();
        const childBinding = await client.open({
          chatId: f.chatId,
          threadId: childThreadId!,
          provenance: { kind: "current" },
        });
        expect(childBinding.ancestorThreadIds).toEqual([threadId]);
        const serverBinding = await client.open({
          chatId: f.chatId,
          threadId,
          provenance: { kind: "current" },
        });
        const rows = () =>
          f!.repository.nativeHistoryBindings.withBinding(
            f!.ownerId,
            f!.workerId,
            f!.chatId,
            serverBinding.id,
            async (tx) => tx.select().from(schema.chatMessages),
          );
        const messages = await rows();
        const initialArchive = await client.archive({
          chatId: f.chatId,
          bindingId: serverBinding.id,
        });
        const imageItem = initialArchive.items.find(
          (item) => item.attachments.length,
        )!;
        expect(imageItem.attachments).toHaveLength(1);
        const [mapping] = await client.resolve({
          chatId: f.chatId,
          bindingId: serverBinding.id,
          items: [
            { identity: imageItem.identity, association: { kind: "existing" } },
          ],
        });
        expect(mapping!.attachments).toEqual(imageItem.attachments);
        const opened = await Promise.all(
          messages.map((message) =>
            decryptChatMessageProtectedContent({
              ownerId: f!.ownerId,
              messageId: message.id,
              componentKey: new Uint8Array(32).fill(47),
              keyRevision: 1,
              encrypted: message.protectedContent!,
              publicClassification: {
                role: message.role,
                mode: message.mode,
                attachmentIds: message.attachmentIds,
              },
            }),
          ),
        );
        const childMessage = opened
          .flatMap((message) => message.content)
          .find(
            (part) =>
              part.type === "text" && part.text === "native child answer",
          );
        expect(childMessage).toMatchObject({
          agentScope: {
            agentThreadId: childThreadId,
            parentThreadId: threadId,
            rootThreadId: threadId,
            rootTurnId: parentTurn.turn.id,
            isRoot: false,
            depth: 1,
          },
        });
        // Native V2 spawn delivers its initial request as agent communication,
        // not a retained userMessage item. This fixture verifies every exposed
        // child item; communication retention is a separate native fidelity gap.
        const toolMessage = opened.find((message) =>
          message.content.some(
            (part) =>
              part.type === "activity" &&
              part.activity.type === "nativeItem" &&
              part.activity.kind === "functionCallOutput",
          ),
        );
        expect(toolMessage?.content.map((part) => part.type)).toEqual([
          "activity",
          "activity",
          "attachment",
          "activity",
        ]);
        expect(toolMessage?.content[1]).toMatchObject({
          activity: { details: "  exact tool output\n".repeat(2_000) },
        });
        expect(toolMessage?.content[3]).toMatchObject({
          activity: { details: "after image" },
        });
        expect(
          initialArchive.items.some(
            (entry) =>
              entry.identity.component === "activity" &&
              entry.attachments.length === 1,
          ),
        ).toBe(true);
        const texts = opened.flatMap((message) =>
          message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
        );
        expect(texts).toEqual(
          expect.arrayContaining([
            "GUI entry fixture",
            "Remote client fixture",
            "native answer 1",
            "native answer 2",
          ]),
        );
        expect(requests).toHaveLength(6);
        expect(new Set(messages.map((message) => message.id)).size).toBe(
          messages.length,
        );
        await history.stop();
        // Startup restores the committed checkpoint without another model turn.
        history = open();
        await history.flush();
        // Losing only local materialization manifests must not replace existing
        // published attachments with newly encrypted metadata.
        await rm(path.join(data, "native-history-canonical", "materialized"), {
          recursive: true,
          force: true,
        });
        history.bind(binding);
        await history.flush();
        expect(
          await readdir(
            path.join(
              data,
              "native-history-canonical",
              "materialized",
              "input-parts",
            ),
          ),
        ).toHaveLength(2);
        expect(
          (
            await client.archive({
              chatId: f.chatId,
              bindingId: serverBinding.id,
            })
          ).items
            .filter((item) => item.attachments.length)
            .map((item) => ({ key: item.key, attachments: item.attachments })),
        ).toEqual(
          initialArchive.items
            .filter((item) => item.attachments.length)
            .map((item) => ({ key: item.key, attachments: item.attachments })),
        );
        expect((await rows()).map((message) => message.id).sort()).toEqual(
          messages.map((message) => message.id).sort(),
        );
        expect(requests).toHaveLength(6);
        // Live item delivery may beat the durable native turn-context row. That
        // specific deferral is retried; the canonical output/recovery assertions
        // above prove eventual publication rather than accepting a dropped page.
        expect(
          errors.filter(
            (error) =>
              !(
                error instanceof Error &&
                error.message ===
                  "Original native turn context is not yet retained."
              ),
          ),
        ).toEqual([
          expect.objectContaining({ message: "fixture lost committed reply" }),
        ]);
      } finally {
        releaseChild();
        socket?.terminate();
        await history?.stop();
        runtime?.close();
        for (const child of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          const done = once(child, "exit");
          const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
          await done.finally(() => clearTimeout(force));
        }
        await f?.close();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
