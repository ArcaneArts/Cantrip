import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import { chatMessageProtectedClassificationSchema } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../cantrip_server/src/db/schema.js";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
const helper = process.env.CANTRIP_CUA_TEST_BINARY?.trim();
type Frame = Record<string, any>;
function send(response: ServerResponse, id: string, item: Frame) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { id: `${id}-item`, ...item } },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe.skipIf(!binary || !helper)("actual native process recovery", () => {
  it.each(["gui", "terminal"] as const)(
    "recovers a %s conversation, history and CUA on a new runtime process",
    async (origin) => {
      const requests: Frame[] = [];
      const issued = new Set<number>();
      const modelErrors: string[] = [];
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(raw);
        requests.push(body);
        const lastUser = JSON.stringify(
          body.input?.findLast(
            (item: Frame) =>
              item.role === "user" &&
              /PROCESS_RECOVERY_[12]/.test(JSON.stringify(item)),
          ),
        );
        const index = Number(lastUser?.match(/PROCESS_RECOVERY_(\d+)/)?.[1]);
        if (![1, 2].includes(index)) {
          modelErrors.push(`Unrecognized recovery input: ${lastUser}`);
          response.writeHead(400).end("Unknown fixture input");
          return;
        }
        if (!issued.has(index)) {
          const inventory: Frame[] =
            body.tools?.flatMap((tool: Frame) =>
              tool.type === "namespace"
                ? tool.tools.map((entry: Frame) => ({
                    ...entry,
                    namespace: tool.name,
                  }))
                : [tool],
            ) ?? [];
          const tool = inventory.find(
            (tool) =>
              (tool.namespace?.includes("cantrip_cua") && tool.name === "js") ||
              tool.name === "mcp__cantrip_cua__js",
          );
          if (!tool) {
            modelErrors.push("Missing CUA tool after managed preparation");
            response.writeHead(400).end("Missing fixture tool");
            return;
          }
          issued.add(index);
          send(response, `recovery-cua-${index}`, {
            type: "function_call",
            call_id: `recovery-cua-${index}`,
            name: tool.name,
            namespace: tool.namespace,
            arguments: JSON.stringify({
              script: `await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.snapshot(); 'recovery-${index}'`,
            }),
          });
        } else
          send(response, `recovery-answer-${index}`, {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: `PROCESS_RESULT_${index}` }],
          });
      });
      let f:
        Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        f = await createNativeSharedViewFixture(
          binary!,
          `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          { computerUse: true },
        );
        const a = f.authority;
        const initialGeneration = f.generation;
        const initialSettings = (
          await f.runtime.readNativeThreadSettings(f.threadId)
        ).confirmed!.settings;
        const turns: string[] = [];
        const binding = await f.historyClient.open({
          chatId: a.chatId,
          threadId: f.threadId,
          provenance: { kind: "current" },
        });
        const rows = () =>
          a.repository.nativeHistoryBindings.withBinding(
            a.ownerId,
            a.workerId,
            a.chatId,
            binding.id,
            (tx) => tx.select().from(schema.chatMessages),
          );
        let beforeIds: string[] = [];
        for (const index of [1, 2]) {
          const guiOrigin = (index === 1) === (origin === "gui");
          const gui = guiOrigin
            ? await f.guiStart(`PROCESS_RECOVERY_${index}`)
            : undefined;
          if (!gui) await f.tuiSend(`PROCESS_RECOVERY_${index}`);
          await vi.waitFor(
            () => {
              expect(modelErrors).toEqual([]);
              expect(f!.messages).toContain(`PROCESS_RESULT_${index}`);
              expect(f!.terminalText()).toContain(`PROCESS_RESULT_${index}`);
            },
            { timeout: 20000 },
          );
          if (gui) {
            const result = await gui.settled;
            expect(result.error).toBeUndefined();
            await gui.finish();
          } else
            await vi.waitFor(() => expect(f!.completed).toHaveLength(1), {
              timeout: 10000,
            });
          const native = await f.runtime.readNativeHistory(f.threadId);
          expect(native.thread.turns).toHaveLength(index);
          const turn = native.thread.turns.at(-1)!;
          expect(turn.status).toBe("completed");
          turns.push(turn.id);
          const cua = f.cua!;
          expect(cua.calls).toHaveLength(index);
          expect(cua.calls[index - 1]!.error).toBeUndefined();
          expect(cua.calls[index - 1]!.result?.isError).not.toBe(true);
          expect(cua.calls[index - 1]!.observedExecution?.turnId).toBe(turn.id);
          expect(JSON.stringify(requests.at(-1)?.input)).toContain(
            "data:image/png;base64,",
          );
          cua.assertRetired(index - 1);
          await f.flushHistory();
          await vi.waitFor(
            async () =>
              expect(
                await a.repository.getChatExecutionContext(a.ownerId, a.chatId),
              ).toMatchObject({ status: "idle", executionLaneId: null }),
            { timeout: 10000 },
          );
          if (index === 1) {
            beforeIds = (await rows()).map((row) => row.id).sort();
            expect(beforeIds.length).toBeGreaterThan(0);
            const snapshot = await f.runtime.readNativeHistory(f.threadId);
            const restarted = await f.restartRuntime();
            expect(f.children).toHaveLength(2);
            expect(f.children[0]!.signalCode).toBe("SIGKILL");
            expect(f.generation).not.toBe(initialGeneration);
            expect(
              (await f.runtime.readNativeHistory(f.threadId)).thread.turns.map(
                (turn) => ({ id: turn.id, status: turn.status }),
              ),
            ).toEqual(
              snapshot.thread.turns.map((turn) => ({
                id: turn.id,
                status: turn.status,
              })),
            );
            expect((await rows()).map((row) => row.id).sort()).toEqual(
              beforeIds,
            );
            expect(requests).toHaveLength(2);
            const settings = (
              await f.runtime.readNativeThreadSettings(f.threadId)
            ).confirmed!.settings;
            expect(settings).toMatchObject({
              model: initialSettings.model,
              effort: initialSettings.effort,
              collaborationMode: initialSettings.collaborationMode,
              approvalPolicy: initialSettings.approvalPolicy,
            });
            const dispatch = vi.fn(async () => ({ interrupted: false }));
            await expect(
              restarted.oldAdapter.executeGuiCommand(restarted.oldSession, {
                method: "turn/interrupt",
                params: { threadId: f.threadId, turnId: turn.id },
                dispatch,
              }),
            ).rejects.toThrow(/transport.*replaced/i);
            expect(dispatch).not.toHaveBeenCalled();
            cua.assertRetired(0);
          }
        }
        expect(new Set(turns).size).toBe(2);
        expect(requests).toHaveLength(4);
        const saved = await rows();
        expect(saved.filter((row) => beforeIds.includes(row.id))).toHaveLength(
          beforeIds.length,
        );
        const opened = await Promise.all(
          saved.map((message) =>
            decryptChatMessageProtectedContent({
              ownerId: a.ownerId,
              messageId: message.id,
              componentKey: new Uint8Array(32).fill(73),
              keyRevision: 1,
              encrypted: message.protectedContent!,
              publicClassification:
                chatMessageProtectedClassificationSchema.parse({
                  role: message.role,
                  mode: message.mode,
                  attachmentIds: message.attachmentIds,
                }),
            }),
          ),
        );
        const texts = opened
          .flatMap((message) => message.content)
          .flatMap((part) =>
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            part.type === "text"
              ? [part.text]
              : [],
          );
        for (const text of [
          "PROCESS_RECOVERY_1",
          "PROCESS_RESULT_1",
          "PROCESS_RECOVERY_2",
          "PROCESS_RESULT_2",
        ])
          expect(
            texts.filter((value) => value === text),
            text,
          ).toHaveLength(1);
        await f.reopenHistory();
        expect((await rows()).map((row) => row.id).sort()).toEqual(
          saved.map((row) => row.id).sort(),
        );
        expect(f.turnFailures).toEqual([]);
        expect(f.terminalSettled()).toBe(false);
      } catch (error) {
        throw new Error(
          `${String(error)}; ${JSON.stringify(f?.diagnostics())}`,
        );
      } finally {
        await f?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    90000,
  );
});

describe.skipIf(!binary)("native pending question crash recovery", () => {
  it.each(["gui", "terminal"] as const)(
    "retires a %s pending request and accepts a fresh opposite-view reply after process loss",
    async (origin) => {
      const requests: Frame[] = [];
      const issued = new Set<number>();
      const modelErrors: string[] = [];
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(raw);
        requests.push(body);
        const lastUser = JSON.stringify(
          body.input?.findLast(
            (item: Frame) =>
              item.role === "user" &&
              /PROCESS_QUESTION_[12]/.test(JSON.stringify(item)),
          ),
        );
        const index = Number(lastUser?.match(/PROCESS_QUESTION_(\d+)/)?.[1]);
        if (![1, 2].includes(index)) {
          modelErrors.push(`Unknown input ${lastUser}`);
          response.writeHead(400).end();
          return;
        }
        if (!issued.has(index)) {
          const tools: Frame[] = body.tools.flatMap((tool: Frame) =>
            tool.type === "namespace"
              ? tool.tools.map((entry: Frame) => ({
                  ...entry,
                  namespace: tool.name,
                }))
              : [tool],
          );
          const tool = tools.find(
            (entry) => entry.name === "request_user_input",
          );
          if (!tool) {
            modelErrors.push("Missing native question tool");
            response.writeHead(400).end();
            return;
          }
          issued.add(index);
          send(response, `question-${index}`, {
            type: "function_call",
            call_id: `question-${index}`,
            name: tool.name,
            namespace: tool.namespace,
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: `QUESTION_PROMPT_${index}`,
                  options: [
                    { label: "First", description: "First fixture option." },
                    { label: "Second", description: "Second fixture option." },
                  ],
                },
              ],
            }),
          });
        } else
          send(response, `question-done-${index}`, {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: `QUESTION_RESULT_${index}` },
            ],
          });
      });
      let f:
        Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        f = await createNativeSharedViewFixture(
          binary!,
          `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          { planMode: "plan" },
        );
        const firstGui =
          origin === "gui" ? await f.guiStart("PROCESS_QUESTION_1") : undefined;
        if (!firstGui) await f.tuiSend("PROCESS_QUESTION_1");
        await vi.waitFor(
          () => {
            expect(modelErrors).toEqual([]);
            expect(f!.interactionRequests).toHaveLength(1);
            expect(f!.terminalText()).toContain("enter to submit answer");
          },
          { timeout: 15000 },
        );
        const old = f.interactionRequests[0]!;
        await f.restartRuntime(async () => {
          await vi.waitFor(() =>
            expect(f!.interactionCleared).toEqual([old.requestKey]),
          );
          if (firstGui) {
            const ended = await firstGui.settled;
            expect(ended.result).toBeUndefined();
            expect(ended.error).toBeInstanceOf(Error);
            await firstGui.finish("failed");
          }
          await vi.waitFor(
            async () =>
              expect(
                await f!.authority.repository.getChatExecutionContext(
                  f!.authority.ownerId,
                  f!.authority.chatId,
                ),
              ).toMatchObject({ status: "failed", executionLaneId: null }),
            { timeout: 10000 },
          );
        });
        expect(requests).toHaveLength(1);
        expect(f.interactionRequests).toEqual([old]);
        const reply = {
          kind: "userInput" as const,
          answers: { choice: { answers: ["First"] } },
        };
        await expect(
          f.runtime.answerAgentInteraction(old.requestKey, reply),
        ).rejects.toThrow();
        expect(requests).toHaveLength(1);
        const recovered = await f.runtime.readNativeHistory(f.threadId);
        expect(recovered.thread.turns).toHaveLength(1);
        expect(recovered.thread.turns[0]!.id).toBe(old.turnId);
        expect(recovered.thread.turns[0]!.status).toBe("interrupted");
        const freshGui =
          origin === "terminal"
            ? await f.guiStart("PROCESS_QUESTION_2")
            : undefined;
        if (!freshGui) await f.tuiSend("PROCESS_QUESTION_2");
        await vi.waitFor(
          () => {
            expect(f!.interactionRequests).toHaveLength(2);
            expect(f!.terminalText()).toContain("QUESTION_PROMPT_2");
            expect(f!.terminalText()).toContain("enter to submit answer");
          },
          { timeout: 15000 },
        );
        const fresh = f.interactionRequests[1]!;
        expect(fresh.requestKey).not.toBe(old.requestKey);
        expect(fresh.turnId).not.toBe(old.turnId);
        await expect(
          f.runtime.answerAgentInteraction(old.requestKey, reply),
        ).rejects.toThrow();
        expect(f.interactionCleared).toEqual([old.requestKey]);
        if (freshGui) f.tuiInput("\r");
        else await f.runtime.answerAgentInteraction(fresh.requestKey, reply);
        await vi.waitFor(
          () => {
            expect(f!.messages).toContain("QUESTION_RESULT_2");
            expect(f!.terminalText()).toContain("QUESTION_RESULT_2");
            expect(f!.interactionCleared).toEqual([
              old.requestKey,
              fresh.requestKey,
            ]);
          },
          { timeout: 15000 },
        );
        if (freshGui) {
          expect((await freshGui.settled).error).toBeUndefined();
          await freshGui.finish();
        } else
          await vi.waitFor(() => expect(f!.completed).toEqual([fresh.turnId]), {
            timeout: 10000,
          });
        expect(requests).toHaveLength(3);
        expect(
          JSON.stringify(
            requests[2]!.input.filter(
              (item: Frame) =>
                item.type === "function_call_output" &&
                item.call_id === "question-2",
            ),
          ),
        ).toContain("First");
        await f.flushHistory();
        const final = await f.runtime.readNativeHistory(f.threadId);
        expect(final.thread.turns.map((turn) => turn.id)).toEqual([
          old.turnId,
          fresh.turnId,
        ]);
        expect(final.thread.turns.at(-1)!.status).toBe("completed");
        expect(f.children).toHaveLength(2);
        expect(f.terminalSettled()).toBe(false);
      } catch (error) {
        throw new Error(
          `${String(error)}; ${JSON.stringify(f?.diagnostics())}`,
        );
      } finally {
        await f?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    90000,
  );
});
