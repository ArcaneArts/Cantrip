import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { chatMessageProtectedClassificationSchema } from "@cantrip/protocol";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../cantrip_server/src/db/schema.js";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
function answer(
  response: ServerResponse,
  id: string,
  text: string,
  phase: string,
) {
  for (const event of [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id,
        phase,
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe.skipIf(!binary)(
  "mixed-origin steering on the pinned native runtime",
  () => {
    it.each(["gui", "terminal"] as const)(
      "retains a %s start and opposite-view steer in one durable turn",
      async (origin) => {
        const requests: {
          body: Record<string, any>;
          response: ServerResponse;
        }[] = [];
        const server = createServer(async (request, response) => {
          let text = "";
          for await (const chunk of request) text += chunk;
          if (!request.url?.startsWith("/v1/")) {
            response.writeHead(404).end();
            return;
          }
          requests.push({ body: JSON.parse(text), response });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `response-${requests.length}` } })}\n\n`,
          );
        });
        let f:
          Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
        try {
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          f = await createNativeSharedViewFixture(
            binary!,
            `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          );
          const first = "SHARED_START_INPUT";
          const steering = "SHARED_STEER_INPUT";
          const gui = origin === "gui" ? await f.guiStart(first) : undefined;
          if (!gui) await f.tuiSend(first);
          await vi.waitFor(() => expect(requests).toHaveLength(1), {
            timeout: 15000,
          });
          const started = f.frames.filter(
            (frame) => frame.method === "turn/started",
          );
          expect(started).toHaveLength(1);
          const turnId = started[0]!.params.turn.id;
          expect(JSON.stringify(requests[0]!.body.input)).toContain(first);
          await vi.waitFor(
            () => expect(f!.terminalText()).toMatch(/esc to interrupt/i),
            { timeout: 15000 },
          );
          if (gui) await f.tuiSend(steering);
          else
            expect(await f.guiSteer(steering)).toEqual({
              steered: true,
              turnId,
            });
          await vi.waitFor(
            () => {
              const steers = f!.authority.phases.filter(
                (entry) =>
                  entry.phase === "admit" && entry.body.method === "turn/steer",
              );
              expect(steers).toHaveLength(1);
              expect(steers[0]!.body.origin).toBe(gui ? "terminal" : "gui");
              expect(steers[0]!.body.intent.expectedTurnId).toBe(turnId);
              expect(steers[0]!.status).toBe(200);
              const receipt = f!.authority.receipts.get(
                steers[0]!.body.operationId,
              );
              expect(receipt?.status).toBe("applied");
            },
            { timeout: 15000 },
          );
          // The provider is still producing the first response when the second
          // interface steers. Complete it only after real native acceptance.
          answer(
            requests[0]!.response,
            "before-steer",
            "BEFORE_STEER_OUTPUT",
            "commentary",
          );
          await vi.waitFor(() => expect(requests).toHaveLength(2), {
            timeout: 15000,
          });
          expect(JSON.stringify(requests[1]!.body.input)).toContain(first);
          expect(JSON.stringify(requests[1]!.body.input)).toContain(steering);
          answer(
            requests[1]!.response,
            "after-steer",
            "AFTER_STEER_OUTPUT",
            "final_answer",
          );
          if (gui) {
            const settled = await gui.settled;
            expect(settled.error).toBeUndefined();
            expect(settled.result?.turnId).toBe(turnId);
            await gui.finish();
          } else
            await vi.waitFor(() => expect(f!.completed).toEqual([turnId]), {
              timeout: 15000,
            });
          await vi.waitFor(
            () => expect(f!.terminalText()).toContain("AFTER_STEER_OUTPUT"),
            { timeout: 15000 },
          );
          expect(f.messages).toContain("AFTER_STEER_OUTPUT");
          expect(
            f.frames.filter((frame) => frame.method === "turn/started"),
          ).toHaveLength(1);
          expect(
            f.frames.filter((frame) => frame.method === "turn/completed"),
          ).toHaveLength(1);
          const native = await f.runtime.readNativeHistory(f.threadId);
          expect(native.thread.turns).toHaveLength(1);
          expect(native.thread.turns[0]).toMatchObject({
            id: turnId,
            status: "completed",
          });
          await f.flushHistory();
          const a = f.authority;
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
          const saved = await rows();
          if (gui) {
            expect(
              saved.filter((row) => row.id === gui.clientMessageId),
            ).toHaveLength(1);
            const archive = await f.historyClient.archive({
              chatId: a.chatId,
              bindingId: binding.id,
            });
            const mappings = await f.historyClient.resolve({
              chatId: a.chatId,
              bindingId: binding.id,
              items: archive.items
                .filter((item) => item.identity.component === "user")
                .map((item) => ({
                  identity: item.identity,
                  association: { kind: "existing" as const },
                })),
            });
            expect(
              mappings.filter(
                (mapping) => mapping.messageId === gui.clientMessageId,
              ),
            ).toEqual([
              expect.objectContaining({
                messageId: gui.clientMessageId,
                preservedInput: gui.originalInput,
              }),
            ]);
          }
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
              part.type === "text" &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            );
          for (const expected of [
            first,
            steering,
            "BEFORE_STEER_OUTPUT",
            "AFTER_STEER_OUTPUT",
          ])
            expect(
              texts.filter((text) => text === expected),
              expected,
            ).toHaveLength(1);
          await f.reopenHistory();
          expect((await rows()).map((row) => row.id).sort()).toEqual(
            saved.map((row) => row.id).sort(),
          );
          expect(requests).toHaveLength(2);
          expect(f.children).toHaveLength(1);
          expect(f.runtime.transportGeneration).toBe(f.generation);
          expect(f.terminalSettled()).toBe(false);
          // Live items can precede their durable presentation context. Only
          // that documented retry is allowed, and flush/reopen above must
          // already have proved its eventual canonical persistence.
          expect(
            f.errors.filter(
              (error) =>
                !(
                  error instanceof Error &&
                  error.message ===
                    "Original native turn context is not yet retained."
                ),
            ),
          ).toEqual([]);
        } catch (error) {
          throw new Error(
            `${String(error)}; ${JSON.stringify(f?.diagnostics())}`,
            { cause: error },
          );
        } finally {
          for (const request of requests) request.response.destroy();
          await f?.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      60000,
    );
  },
);
