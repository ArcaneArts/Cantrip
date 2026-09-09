import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { CodexNativeRpcError } from "../src/codex/app-server.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import { renderNativeHistoryItem } from "../src/native-history-render.js";
import { createNativeHistoryProjectorAdapters } from "../src/native-history-projector-adapters.js";
import { AttachmentStore } from "../src/attachment-store.js";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import {
  nativeHistoryUserMessage,
  readCodexNativeHistory,
} from "../src/codex/native-history.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type ObjectValue = Record<string, any>;
const durableMetadata = (history: ObjectValue | null | undefined) => {
  if (!history) return null;
  const { live: _live, ...durable } = history;
  return durable;
};
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=";

describe.skipIf(!binary)("pinned native history foundation", () => {
  it.each([
    { canonicalHistory: false, historyMode: "legacy" },
    { canonicalHistory: true, historyMode: "legacy" },
    { canonicalHistory: false, historyMode: "paginated" },
    { canonicalHistory: true, historyMode: "paginated" },
  ] as const)(
    "preserves $historyMode history with canonicalHistory=$canonicalHistory across restart",
    async ({ canonicalHistory, historyMode }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-native-history-"),
      );
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "workspace");
      const requests: ObjectValue[] = [];
      const notifications: ObjectValue[] = [];
      const providerErrors: unknown[] = [];
      const observations = new NativeHistoryObservations();
      const source: Awaited<ReturnType<NativeHistorySourceJournal["read"]>> =
        [];
      let releaseFinal!: () => void;
      const finalRelease = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      let releaseStreamEnd!: () => void;
      const streamEnd = new Promise<void>((resolve) => {
        releaseStreamEnd = resolve;
      });
      let releaseRich!: () => void;
      let arriveRich!: () => void;
      const richRelease = new Promise<void>((resolve) => {
        releaseRich = resolve;
      });
      const richArrived = new Promise<void>((resolve) => {
        arriveRich = resolve;
      });
      let releaseChild!: () => void;
      const childRelease = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      let responseIndex = 0;
      let exerciseChild = false;
      let spawnIssued = false;
      const provider = createServer(async (request, response) => {
        try {
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          const input = JSON.parse(body) as ObjectValue;
          requests.push(input);
          const index = ++responseIndex;
          if (
            exerciseChild &&
            JSON.stringify(input.input).includes("HISTORY_CHILD_FIXTURE") &&
            !JSON.stringify(input.input).includes("HISTORY_PARENT_FIXTURE")
          )
            await childRelease;
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          const emit = (event: ObjectValue) =>
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          emit({
            type: "response.created",
            response: { id: `response-${index}` },
          });
          const message = (id: string, text: string, phase = "final_answer") =>
            emit({
              type: "response.output_item.done",
              item: {
                id,
                type: "message",
                role: "assistant",
                phase,
                content: [{ type: "output_text", text }],
              },
            });
          if (
            exerciseChild &&
            !spawnIssued &&
            JSON.stringify(input.input).includes("HISTORY_PARENT_FIXTURE")
          ) {
            const tool = (input.tools as ObjectValue[]).find((entry) =>
              entry.name?.endsWith("spawn_agent"),
            );
            if (!tool) {
              throw new Error(
                `No native spawn tool: ${JSON.stringify((input.tools ?? []).map((tool: ObjectValue) => tool.name ?? tool.type))}`,
              );
            }
            const properties = tool.parameters?.properties ?? {};
            spawnIssued = true;
            emit({
              type: "response.output_item.done",
              item: {
                id: "spawn-item",
                type: "function_call",
                call_id: "history-child-spawn",
                name: tool.name,
                arguments: JSON.stringify({
                  message:
                    "HISTORY_CHILD_FIXTURE: return a short child answer.",
                  ...(properties.task_name
                    ? { task_name: "history_child" }
                    : {}),
                  ...(properties.fork_turns ? { fork_turns: "none" } : {}),
                  ...(properties.fork_context ? { fork_context: false } : {}),
                }),
              },
            });
          } else if (index === 2) {
            const streamingItem = {
              id: "streaming-commentary",
              type: "message",
              role: "assistant",
              phase: "commentary",
              content: [],
            };
            emit({
              type: "response.output_item.added",
              output_index: 0,
              item: streamingItem,
            });
            emit({
              type: "response.output_text.delta",
              item_id: streamingItem.id,
              output_index: 0,
              content_index: 0,
              delta: "Streaming prefix.",
            });
            arriveRich();
            await richRelease;
            emit({
              type: "response.output_text.delta",
              item_id: streamingItem.id,
              output_index: 0,
              content_index: 0,
              delta: " tail.",
            });
            await streamEnd;
            emit({
              type: "response.output_text.delta",
              item_id: streamingItem.id,
              output_index: 0,
              content_index: 0,
              delta: " again.",
            });
            await finalRelease;
            message(
              streamingItem.id,
              "Streaming prefix. tail. again.",
              "commentary",
            );
            emit({
              type: "response.output_item.done",
              item: {
                id: "reasoning-source",
                type: "reasoning",
                summary: [
                  {
                    type: "summary_text",
                    text: "A retained reasoning summary.",
                  },
                ],
              },
            });
            message("same-one", "Identical commentary.", "commentary");
            message("same-two", "Identical commentary.", "commentary");
            const tools = input.tools as ObjectValue[];
            if (!tools)
              throw new Error(
                "Native fixture requires the standard Responses tool catalog.",
              );
            const tool = tools.find(
              (entry) =>
                entry.name === "exec_command" || entry.name === "shell_command",
            );
            if (!tool)
              throw new Error(
                "Native request did not expose its command tool.",
              );
            emit({
              type: "response.output_item.done",
              item: {
                id: "call-item",
                type: "function_call",
                call_id: "native-history-call",
                name: tool.name,
                arguments: JSON.stringify(
                  tool.name === "exec_command"
                    ? { cmd: "printf native-history-tool-output", workdir: cwd }
                    : {
                        command: "printf native-history-tool-output",
                        workdir: cwd,
                      },
                ),
              },
            });
          } else message(`answer-${index}`, `History answer ${index}.`);
          emit({
            type: "response.completed",
            response: {
              id: `response-${index}`,
              usage: {
                input_tokens: index * 10,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens: index * 3,
                output_tokens_details: { reasoning_tokens: 1 },
                total_tokens: index * 13,
              },
            },
          });
          response.end();
        } catch (error) {
          providerErrors.push(error);
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let client: CodexRpcClient | undefined;
      const stop = async () => {
        const current = child;
        if (
          !current ||
          current.exitCode !== null ||
          current.signalCode !== null
        )
          return;
        const exited = once(current, "close");
        let forced = false;
        const timer = setTimeout(() => {
          forced = true;
          current.kill("SIGKILL");
        }, 5_000);
        try {
          client?.close();
          await exited;
        } finally {
          clearTimeout(timer);
          child = undefined;
          client = undefined;
        }
        expect(forced, "Native history fixture failed to close").toBe(false);
      };
      const start = async () => {
        observations.replace(randomUUID());
        child = spawn(binary!, ["app-server"], {
          cwd,
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
          stdio: "pipe",
        });
        client = new CodexRpcClient(child, 20_000);
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          try {
            const frame = JSON.parse(line);
            if (frame.method) {
              notifications.push(frame);
              observations.notification(
                frame.method,
                frame.params,
                frame.historyCursor,
              );
            }
          } catch {
            /* non-protocol stderr is handled by CodexRpcClient */
          }
        });
        await rpc("initialize", {
          clientInfo: { name: "cantrip_history_foundation", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
      };
      const rpc = async (
        method: string,
        params: ObjectValue,
      ): Promise<ObjectValue> => {
        const reply = await client!.request(method, params);
        if (reply.error)
          throw new CodexNativeRpcError(
            reply.error.message,
            reply.error,
            method,
          );
        return reply.result as ObjectValue;
      };
      const config = {
        mcpServers: {},
        developerInstructions: "History fixture profile.",
        multiAgentEnabled: true,
        subagentModel: null,
        subagentReasoningEffort: null,
      };
      const turn = async (
        threadId: string,
        clientUserMessageId: string,
        input: ObjectValue[],
        onStarted?: (turnId: string) => Promise<void>,
        settings: ObjectValue = {},
      ) => {
        const ack = await rpc("turn/start", {
          threadId,
          clientUserMessageId,
          input,
          ...settings,
        });
        await onStarted?.(ack.turn.id);
        const ended = await client!.waitForNotification(
          "turn/completed",
          (params) =>
            (params as ObjectValue).threadId === threadId &&
            (params as ObjectValue).turn.id === ack.turn.id,
        );
        expect(
          (ended.params as ObjectValue).turn.status,
          JSON.stringify({
            turn: (ended.params as ObjectValue).turn,
            providerErrors: providerErrors.map(String),
          }),
        ).toBe("completed");
        return ack.turn.id as string;
      };
      try {
        await Promise.all([mkdir(home), mkdir(cwd)]);
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
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        await writeFile(
          path.join(home, "config.toml"),
          [
            'model = "gpt-5"',
            'model_provider = "history_fixture"',
            'approval_policy = "never"',
            'sandbox_mode = "read-only"',
            "features.plugins = false",
            "features.multi_agent = true",
            `model_catalog_json = ${JSON.stringify(modelCatalog)}`,
            "[model_providers.history_fixture]",
            'name = "History fixture"',
            `base_url = "http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`,
            'wire_api = "responses"',
            "requires_openai_auth = false",
            "request_max_retries = 0",
            "stream_max_retries = 0",
            "",
          ].join("\n"),
        );
        await start();
        const started = await rpc("thread/start", {
          cwd,
          historyMode,
          model: "gpt-5",
          modelProvider: "history_fixture",
          approvalPolicy: "never",
          sandbox: "read-only",
          managedConfig: { ...config, canonicalHistory: false },
        });
        const threadId = started.thread.id as string;
        const oldTurnId = await turn(threadId, "legacy-client", [
          { type: "text", text: "Existing legacy input." },
        ]);
        const before = await readCodexNativeHistory(rpc, threadId);
        if (process.env.REQUIRE_NATIVE_TURN_CONTEXT === "1")
          expect(
            before.history!.turns.find((turn) => turn.turnId === oldTurnId)!
              .contexts,
          ).toMatchObject([
            {
              cwd,
              model: "gpt-5",
              collaborationMode: "default",
              rootTurnId: oldTurnId,
            },
          ]);
        const oldItems = before.thread.turns.find(
          (value) => value.id === oldTurnId,
        )!.items;
        if (historyMode === "legacy") {
          expect(oldItems.some((item) => item.id.startsWith("item-"))).toBe(
            true,
          );
        }
        expect(
          nativeHistoryUserMessage(
            oldItems.find((item) => item.type === "userMessage")!,
          )?.clientId,
        ).toBe("legacy-client");
        if (!canonicalHistory) {
          // Older native bundles omit this additive metadata; never label their
          // reconstructed item IDs canonical or turn missing usage into zero.
          if (before.history)
            expect(
              before.history.turns.find((value) => value.turnId === oldTurnId),
            ).toMatchObject({
              source: historyMode === "legacy" ? "legacy" : "canonical",
              warnings: null,
            });
        }
        await rpc("thread/managedConfig/update", {
          threadId,
          ...config,
          ...(canonicalHistory ? { canonicalHistory: true } : {}),
        });
        const canonicalInput = [{ type: "image", url: image, detail: null }];
        const subscribe = () =>
          observations.subscribe(
            threadId,
            {
              capture(frame) {
                source.push({
                  sequence: source.length + 1,
                  recordId: randomUUID(),
                  frame,
                });
              },
              onError(error) {
                providerErrors.push(error);
              },
            },
            () => readCodexNativeHistory(rpc, threadId),
          );
        let observation = subscribe();
        const canonicalTurnId = await turn(
          threadId,
          "cantrip:canonical-input",
          canonicalInput,
          async (turnId) => {
            try {
              await richArrived;
              await client!.waitForNotification(
                "item/agentMessage/delta",
                (params) =>
                  (params as ObjectValue).threadId === threadId &&
                  (params as ObjectValue).delta === "Streaming prefix.",
              );
              const observed = await observation.readSnapshot();
              const running = observed.snapshot;
              source.push({
                sequence: source.length + 1,
                recordId: randomUUID(),
                frame: observed,
              });
              expect(running.thread.status.type).toBe("active");
              expect(
                running.thread.turns.find((value) => value.id === turnId)
                  ?.status,
              ).toBe("inProgress");
              if (canonicalHistory)
                expect(running.history).toMatchObject({
                  currentTurnId: turnId,
                  currentTurnState: "live",
                });
              if (canonicalHistory) {
                const snapshotItem = running.thread.turns
                  .find((value) => value.id === turnId)!
                  .items.find((value) => value.id === "streaming-commentary")!;
                // The pinned snapshot retains the start payload, even after the native
                // delta has been received. A completed read is not a content watermark.
                expect(snapshotItem.text).toBe("");
                const reduced = reduceNativeHistory(null, source, threadId);
                const projected = () =>
                  reduced.turns
                    .find((value) => value.id === turnId)!
                    .items.find(
                      (value) => value.id === "streaming-commentary",
                    )!;
                expect(projected().body.text).toBe("Streaming prefix.");
                if (process.env.CANTRIP_REQUIRE_NATIVE_LIVE_HISTORY === "1")
                  expect(running.history?.live).toBeDefined();
                if (running.history?.live) {
                  const prefixCursor = running.history.live.items.find(
                    (entry) => entry.item.id === "streaming-commentary",
                  )!.cursor;
                  await rpc("thread/unsubscribe", { threadId });
                  releaseRich();
                  // No presentation is subscribed while the provider sends this delta.
                  // Read-only history must retain it without reconnecting or executing input.
                  await expect
                    .poll(
                      async () => {
                        const missed = await readCodexNativeHistory(
                          rpc,
                          threadId,
                        );
                        return missed.history?.live?.items.find(
                          (entry) => entry.item.id === "streaming-commentary",
                        )?.item.text;
                      },
                      { timeout: 10_000, interval: 20 },
                    )
                    .toBe("Streaming prefix. tail.");
                  expect(
                    notifications.some(
                      (frame) =>
                        frame.method === "item/agentMessage/delta" &&
                        frame.params.delta === " tail.",
                    ),
                  ).toBe(false);
                  observations.replace(randomUUID());
                  source.length = 0; // Reconnect with no previous worker-local item state.
                  observation = subscribe();
                  await rpc("thread/resume", { threadId });
                  const restored = await observation.readSnapshot();
                  source.push({
                    sequence: source.length + 1,
                    recordId: randomUUID(),
                    frame: restored,
                  });
                  const recovered = reduceNativeHistory(null, source, threadId);
                  const recoveredItem = recovered.turns
                    .find((value) => value.id === turnId)!
                    .items.find(
                      (value) => value.id === "streaming-commentary",
                    )!;
                  expect(recoveredItem.body.text).toBe(
                    "Streaming prefix. tail.",
                  );
                  expect(recoveredItem.origin.nativeCursor?.epoch).toBe(
                    prefixCursor.epoch,
                  );
                  const through = source.length;
                  releaseStreamEnd();
                  await client!.waitForNotification(
                    "item/agentMessage/delta",
                    (params) =>
                      (params as ObjectValue).threadId === threadId &&
                      (params as ObjectValue).delta === " again.",
                  );
                  const continued = reduceNativeHistory(
                    recovered,
                    source.slice(through),
                    threadId,
                  );
                  expect(
                    continued.turns
                      .find((value) => value.id === turnId)!
                      .items.find(
                        (value) => value.id === "streaming-commentary",
                      )!.body.text,
                  ).toBe("Streaming prefix. tail. again.");
                } else {
                  const through = source.length;
                  releaseRich();
                  await client!.waitForNotification(
                    "item/agentMessage/delta",
                    (params) =>
                      (params as ObjectValue).threadId === threadId &&
                      (params as ObjectValue).delta === " tail.",
                  );
                  const continued = reduceNativeHistory(
                    reduced,
                    source.slice(through),
                    threadId,
                  );
                  expect(
                    continued.turns
                      .find((value) => value.id === turnId)!
                      .items.find(
                        (value) => value.id === "streaming-commentary",
                      )!.body.text,
                  ).toBe("Streaming prefix. tail.");
                }
              }
            } finally {
              releaseRich();
              releaseStreamEnd();
              releaseFinal();
            }
          },
        );
        observation.close();
        const liveItems = notifications
          .filter(
            (frame) =>
              frame.method === "item/completed" &&
              frame.params.threadId === threadId &&
              frame.params.turnId === canonicalTurnId,
          )
          .map((frame) => frame.params.item);
        const rich = await readCodexNativeHistory(rpc, threadId);
        const ordinary = await rpc("thread/read", {
          threadId,
          includeTurns: true,
        });
        expect(ordinary.thread.turns).toEqual(rich.thread.turns);
        const metadataOnly = await rpc("thread/read", {
          threadId,
          includeTurns: false,
          includeHistoryMetadata: true,
        });
        expect(metadataOnly.thread.turns).toEqual([]);
        expect(metadataOnly.history ?? null).toEqual(
          durableMetadata(rich.history),
        );
        expect(providerErrors).toEqual([]);
        expect(requests).toHaveLength(3);
        expect(
          rich.thread.turns.find((value) => value.id === oldTurnId)!.items,
        ).toEqual(oldItems);
        const canonical = rich.thread.turns.find(
          (value) => value.id === canonicalTurnId,
        )!;
        if (canonicalHistory) {
          const finalState = reduceNativeHistory(null, source, threadId);
          const streamed = finalState.turns
            .find((value) => value.id === canonicalTurnId)!
            .items.find((value) => value.id === "streaming-commentary")!;
          expect(streamed.lifecycle).toBe("completed");
          expect(streamed.body).toEqual(
            canonical.items.find((value) => value.id === streamed.id),
          );
          const reducedTurn = finalState.turns.find(
            (value) => value.id === canonicalTurnId,
          )!;
          const attachmentBinding: NativeHistoryBinding = {
            id: randomUUID(),
            chatId: randomUUID(),
            workerId: randomUUID(),
            threadId,
            projectId: randomUUID(),
            worktreeId: randomUUID(),
            modelRouteId: null,
            providerAccountId: null,
            createdFromOperationId: null,
            createdAt: new Date().toISOString(),
          };
          const encryption = {
            ownerId: () => "native-fixture-owner",
            serverIdentity: () => "native-fixture-server",
            componentKey: () => ({
              key: new Uint8Array(32).fill(76),
              keyRevision: 1,
            }),
          } as unknown as WorkerEncryptionService;
          const files = new AttachmentStore(directory);
          const savedSource = await NativeHistorySourceJournal.open({
            directory: path.join(directory, "actual-native-source"),
            workerId: attachmentBinding.workerId,
            chatId: attachmentBinding.chatId,
            bindingId: attachmentBinding.id,
            threadId,
            service: encryption,
          });
          for (const record of source) await savedSource.append(record.frame);
          const adapters = () =>
            createNativeHistoryProjectorAdapters({
              directory: path.join(directory, "native-adapters"),
              binding: attachmentBinding,
              source: savedSource,
              service: encryption,
              attachments: files,
            });
          const adapter = adapters();
          await adapter.prepare!();
          for (const item of reducedTurn.items) {
            const presentation = await adapter.context(item, reducedTurn);
            expect(presentation).toEqual({ cwd, mode: "default" });
            const material = await adapter.materialize(
              item,
              reducedTurn,
              presentation,
            );
            if (item.body.type === "userMessage") {
              expect(material.attachments).toHaveLength(1);
              const content = material.inputParts!.get(0)![0]!;
              if (content.type !== "attachment")
                throw new Error("Native image was not materialized.");
              const file = files.resolve(
                attachmentBinding.chatId,
                content.attachment.id,
                content.attachment.fileName,
              );
              expect(await readFile(file)).toEqual(
                Buffer.from(image.split(",")[1]!, "base64"),
              );
              await rm(file);
              const reopened = adapters();
              await reopened.prepare!();
              expect(
                await reopened.materialize(
                  item,
                  reducedTurn,
                  await reopened.context(item, reducedTurn),
                ),
              ).toEqual(material);
              expect(await readFile(file)).toEqual(
                Buffer.from(image.split(",")[1]!, "base64"),
              );
            }
            const drafts = renderNativeHistoryItem(item, {
              inputParts: material.inputParts,
              threadId,
              turnId: canonicalTurnId,
              ...presentation,
            });
            expect(drafts.length).toBeGreaterThan(0);
            expect(drafts[0]!.source).toEqual(item);
            expect(drafts[0]!.identity.itemId).toBe(item.id);
            expect(
              drafts.flatMap((draft) => draft.unresolved),
              String(item.body.type),
            ).toEqual([]);
          }
        }
        if (canonicalHistory || historyMode === "paginated")
          expect(canonical.items).toEqual(liveItems);
        const user = nativeHistoryUserMessage(
          canonical.items.find((item) => item.type === "userMessage")!,
        );
        expect(user?.clientId).toBe("cantrip:canonical-input");
        expect(user?.content).toEqual(canonicalInput);
        const identical = canonical.items.filter(
          (item) =>
            item.type === "agentMessage" &&
            item.text === "Identical commentary.",
        );
        expect(identical).toHaveLength(2);
        expect(new Set(identical.map((item) => item.id)).size).toBe(2);
        expect(
          canonical.items.some(
            (item) =>
              item.type === "reasoning" &&
              JSON.stringify(item).includes("A retained reasoning summary."),
          ),
        ).toBe(true);
        expect(
          (canonicalHistory ? canonical.items : liveItems).some(
            (item) =>
              item.type === "commandExecution" &&
              JSON.stringify(item).includes("native-history-tool-output"),
          ),
          JSON.stringify({
            items: canonical.items,
            liveItems,
            toolReplies: requests
              .at(-1)
              ?.input?.filter(
                (item: ObjectValue) => item.type === "function_call_output",
              ),
          }),
        ).toBe(true);
        if (canonicalHistory) {
          const metadata = rich.history!.turns.find(
            (value) => value.turnId === canonicalTurnId,
          )!;
          expect(metadata.source).toBe("canonical");
          expect(metadata.retention).toBe("complete");
          expect(metadata.errors).toEqual([]);
          expect(metadata.warnings).toEqual([]);
          expect(metadata.usage?.conflictingResponseIds).toEqual([]);
          expect(
            metadata.items.every((item) => item.state === "completed"),
          ).toBe(true);
          expect(
            metadata.usage?.responses.map((value) => value.responseId),
          ).toEqual(["response-2", "response-3"]);
          expect(metadata.usage?.total).toMatchObject({
            inputTokens: 50,
            outputTokens: 15,
            totalTokens: 65,
          });
          expect(metadata.items.map((value) => value.itemId)).toEqual(
            canonical.items.map((value) => value.id),
          );
        }
        await stop();
        await start();
        const cold = await readCodexNativeHistory(rpc, threadId);
        const ordinaryCold = await rpc("thread/read", {
          threadId,
          includeTurns: true,
        });
        expect(ordinaryCold.thread.turns).toEqual(cold.thread.turns);
        expect(cold.thread.status.type).toBe("notLoaded");
        const coldMetadataOnly = await rpc("thread/read", {
          threadId,
          includeTurns: false,
          includeHistoryMetadata: true,
        });
        expect(coldMetadataOnly.thread.turns).toEqual([]);
        expect(coldMetadataOnly.thread.status.type).toBe("notLoaded");
        expect(coldMetadataOnly.history ?? null).toEqual(cold.history);
        expect(cold.thread.turns).toEqual(rich.thread.turns);
        expect(cold.history).toEqual(
          rich.history === null
            ? null
            : {
                ...durableMetadata(rich.history),
                currentTurnId: null,
                currentTurnState: "notLoaded",
              },
        );
        expect(requests).toHaveLength(3);
        if (!canonicalHistory) return;
        expect(rich.history).toMatchObject({
          currentTurnId: null,
          currentTurnState: "live",
        });
        const requestsBeforeRead = requests.length;
        const resumed = await rpc("thread/resume", {
          threadId,
          managedConfig: { ...config, canonicalHistory: false },
        });
        expect(resumed.thread.turns).toEqual(cold.thread.turns);
        const changedCwd = path.join(directory, "later-workspace");
        await mkdir(changedCwd);
        const disabledTurnId = await turn(
          threadId,
          "disabled-client",
          [{ type: "text", text: "Future legacy input." }],
          undefined,
          {
            cwd: changedCwd,
            collaborationMode: {
              mode: "plan",
              settings: {
                model: "gpt-5",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
          },
        );
        const disabled = await readCodexNativeHistory(rpc, threadId);
        if (process.env.REQUIRE_NATIVE_TURN_CONTEXT === "1") {
          expect(
            disabled.history!.turns.find((turn) => turn.turnId === oldTurnId)!
              .contexts,
          ).toEqual(
            before.history!.turns.find((turn) => turn.turnId === oldTurnId)!
              .contexts,
          );
          expect(
            disabled.history!.turns.find(
              (turn) => turn.turnId === disabledTurnId,
            )!.contexts,
          ).toEqual([
            {
              cwd: changedCwd,
              model: "gpt-5",
              collaborationMode: "plan",
              reasoningEffort: "high",
              rootTurnId: disabledTurnId,
            },
          ]);
        }
        expect(
          disabled.history!.turns.find(
            (value) => value.turnId === disabledTurnId,
          )!.source,
        ).toBe(historyMode === "legacy" ? "legacy" : "canonical");
        expect(
          disabled.thread.turns.find((value) => value.id === canonicalTurnId)!
            .items,
        ).toEqual(canonical.items);
        expect(requests).toHaveLength(requestsBeforeRead + 1);
        // Exercise actual native child creation after proving explicit disable above.
        // The child must inherit retention without a separate host update for its new ID.
        await rpc("thread/managedConfig/update", {
          threadId,
          ...config,
          canonicalHistory: true,
          multiAgentEnabled: true,
        });
        exerciseChild = true;
        const parentTurnId = await turn(
          threadId,
          "parent-client",
          [
            {
              type: "text",
              text: "HISTORY_PARENT_FIXTURE: spawn the controlled child.",
            },
          ],
          undefined,
          {
            cwd,
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-5",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
          },
        );
        const parent = await readCodexNativeHistory(rpc, threadId);
        const spawnItem = parent.thread.turns
          .find((value) => value.id === parentTurnId)!
          .items.find(
            (item) =>
              item.type === "subAgentActivity" && item.kind === "started",
          );
        expect(spawnItem).toBeDefined();
        expect(spawnItem!.agentPath).toBe("/root/history_child");
        const childThreadId = spawnItem!.agentThreadId as string;
        // Complete the child only after the parent's terminal read, exercising the raw
        // late-activity path rather than relying on scheduling to cover it accidentally.
        releaseChild();
        await expect
          .poll(
            async () => {
              const observed = await readCodexNativeHistory(rpc, childThreadId);
              return observed.thread.turns.at(-1)?.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe("completed");
        const childHistory = await readCodexNativeHistory(rpc, childThreadId);
        await expect
          .poll(
            async () => {
              const observed = await readCodexNativeHistory(rpc, threadId);
              return observed.thread.turns
                .find((turn) => turn.id === parentTurnId)!
                .items.some(
                  (item) =>
                    item.type === "subAgentActivity" &&
                    item.kind === "completed" &&
                    item.agentThreadId === childThreadId,
                );
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe(true);
        const parentAfterChild = await readCodexNativeHistory(rpc, threadId);
        expect(childHistory.thread.parentThreadId).toBe(threadId);
        const childTurn = childHistory.thread.turns.at(-1)!;
        expect(
          childTurn.items.find(
            (item) => item.type === "interAgentCommunication",
          ),
        ).toMatchObject({
          author: "/root",
          recipient: "/root/history_child",
          triggerTurn: true,
          // This synthetic tool result uses the native encrypted-argument path.
          // Opaque payloads must remain retained without becoming display text.
          text: null,
          encryptedContent: expect.stringContaining("HISTORY_CHILD_FIXTURE"),
        });
        const childMetadata = childHistory.history!.turns.find(
          (value) => value.turnId === childTurn.id,
        )!;
        expect(childMetadata).toMatchObject({
          source: "canonical",
          retention: "complete",
        });
        if (process.env.REQUIRE_NATIVE_TURN_CONTEXT === "1") {
          expect(childMetadata.contexts?.length).toBeGreaterThan(0);
          expect(
            childMetadata.contexts?.every(
              (context) => context.rootTurnId === parentTurnId,
            ),
          ).toBe(true);
        }
        expect(childMetadata.items.map((item) => item.itemId)).toEqual(
          childTurn.items.map((item) => item.id),
        );
        expect(
          childMetadata.items.every((item) => item.state === "completed"),
        ).toBe(true);
        expect(childMetadata.usage?.responses.length).toBeGreaterThan(0);
        expect(
          childMetadata.usage?.responses.every(
            (response) =>
              response.threadId === childThreadId &&
              response.rootTurnId === parentTurnId,
          ),
        ).toBe(true);
        expect(providerErrors).toEqual([]);
        await stop();
        await start();
        const coldChild = await readCodexNativeHistory(rpc, childThreadId);
        expect(coldChild.thread.status.type).toBe("notLoaded");
        expect(coldChild.thread.turns).toEqual(childHistory.thread.turns);
        expect(coldChild.history).toEqual({
          ...durableMetadata(childHistory.history),
          currentTurnId: null,
          currentTurnState: "notLoaded",
        });
        const coldParent = await readCodexNativeHistory(rpc, threadId);
        expect(coldParent.thread.turns).toEqual(parentAfterChild.thread.turns);
        expect(coldParent.history).toEqual({
          ...durableMetadata(parentAfterChild.history),
          currentTurnId: null,
          currentTurnState: "notLoaded",
        });
      } finally {
        releaseRich();
        releaseStreamEnd();
        releaseFinal();
        releaseChild();
        await stop();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
