import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

async function control<T>(name: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} blocked behind pending pause`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function answer(response: ServerResponse, id: string, text: string) {
  for (const event of [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id,
        phase: "final_answer",
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

describe.skipIf(!binary)("shared pause on the pinned native runtime", () => {
  it.each([
    ["gui", "resume"],
    ["terminal", "resume"],
    ["gui", "stop"],
    ["terminal", "stop"],
    ["gui", "reply"],
    ["terminal", "reply"],
  ] as const)(
    "%s execution supports %s across a pending pause boundary",
    async (origin, action) => {
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
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `pause-${requests.length}` } })}\n\n`,
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
          { planMode: action === "reply" ? "plan" : "default" },
        );
        const gui =
          origin === "gui" ? await f.guiStart("PAUSE_START") : undefined;
        if (!gui) await f.tuiSend("PAUSE_START");
        await vi.waitFor(() => expect(requests).toHaveLength(1), {
          timeout: 15000,
        });
        const turnId = f.frames.find(
          (frame) => frame.method === "turn/started",
        )!.params.turn.id;
        await vi.waitFor(
          () => expect(f!.terminalText()).toMatch(/esc to interrupt/i),
          { timeout: 15000 },
        );
        if (action === "reply") {
          const tools = requests[0]!.body.tools.flatMap(
            (tool: Record<string, any>) =>
              tool.type === "namespace"
                ? tool.tools.map((entry: Record<string, any>) => ({
                    ...entry,
                    namespace: tool.name,
                  }))
                : [tool],
          );
          const tool = tools.find(
            (entry: Record<string, any>) => entry.name === "request_user_input",
          );
          expect(tool).toBeDefined();
          for (const event of [
            {
              type: "response.output_item.done",
              item: {
                id: "pause-question",
                type: "function_call",
                call_id: "pause-question-call",
                name: tool.name,
                namespace: tool.namespace,
                arguments: JSON.stringify({
                  questions: [
                    {
                      id: "choice",
                      header: "Choice",
                      question: "Choose while pause is pending.",
                      options: [
                        { label: "First", description: "First option." },
                        { label: "Second", description: "Second option." },
                      ],
                    },
                  ],
                }),
              },
            },
            {
              type: "response.completed",
              response: {
                id: "pause-question-response",
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              },
            },
          ])
            requests[0]!.response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          requests[0]!.response.end();
          await vi.waitFor(
            () => {
              expect(f!.interactionRequests).toHaveLength(1);
              expect(f!.terminalText()).toContain("enter to submit answer");
            },
            { timeout: 15000 },
          );
        }
        let pauseSettled = false;
        const pause = f.runtime
          .setActiveChatPaused(f.authority.chatId, true)
          .then(
            (result) => {
              pauseSettled = true;
              return { result, error: undefined };
            },
            (error) => {
              pauseSettled = true;
              return { result: undefined, error };
            },
          );
        await vi.waitFor(
          () => {
            const admitted = f!.authority.phases.find(
              (entry) =>
                entry.phase === "admit" && entry.body.method === "turn/pause",
            );
            expect(admitted).toBeDefined();
            expect(
              f!.authority.phases.some(
                (entry) =>
                  entry.phase === "dispatch" &&
                  entry.body.operationId === admitted!.body.operationId &&
                  entry.status === 200,
              ),
            ).toBe(true);
          },
          { timeout: 15000 },
        );
        // The stream is held open by this fixture. No native safe boundary has
        // happened yet, so a successful pause acknowledgement would be premature.
        expect(pauseSettled).toBe(false);
        if (action !== "stop") {
          // Steering keeps the same turn alive across the completed response and
          // proves the next provider request is withheld at the pause boundary.
          if (action === "reply") {
            if (gui) f.tuiInput("\r");
            else
              await control(
                "reply",
                f.runtime.answerAgentInteraction(
                  f.interactionRequests[0]!.requestKey,
                  {
                    kind: "userInput",
                    answers: { choice: { answers: ["First"] } },
                  },
                ),
              );
          } else {
            expect(
              await control("steer", f.guiSteer("PAUSE_CONTINUE")),
            ).toEqual({
              steered: true,
              turnId,
            });
            answer(requests[0]!.response, "before-pause", "BEFORE_PAUSE");
          }
          const paused = await control("pause acknowledgement", pause);
          expect(paused.error).toBeUndefined();
          expect(paused.result).toEqual({ threadId: f.threadId, turnId });
          expect(
            (
              await f.authority.repository.getChatExecutionContext(
                f.authority.ownerId,
                f.authority.chatId,
              )
            )?.automationPaused,
          ).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 250));
          expect(requests).toHaveLength(1);
          expect(
            f.frames.filter((frame) => frame.method === "turn/completed"),
          ).toHaveLength(0);
          expect(
            await control(
              "resume",
              f.runtime.setActiveChatPaused(f.authority.chatId, false),
            ),
          ).toEqual({ threadId: f.threadId, turnId });
          expect(
            (
              await f.authority.repository.getChatExecutionContext(
                f.authority.ownerId,
                f.authority.chatId,
              )
            )?.automationPaused,
          ).toBe(false);
          await vi.waitFor(() => expect(requests).toHaveLength(2), {
            timeout: 15000,
          });
          expect(JSON.stringify(requests[1]!.body.input)).toContain(
            action === "reply" ? "First" : "PAUSE_CONTINUE",
          );
          answer(requests[1]!.response, "after-resume", "AFTER_RESUME");
        } else {
          // Cross-view Stop must bypass the still-pending native pause RPC while
          // the fixture deliberately keeps the provider response unfinished.
          if (gui) f.tuiStop();
          else await control("Stop", f.guiStop());
          await vi.waitFor(
            () =>
              expect(
                f!.frames.some(
                  (frame) =>
                    frame.method === "turn/completed" &&
                    frame.params.turn.id === turnId,
                ),
              ).toBe(true),
            { timeout: 15000 },
          );
          await vi.waitFor(() => expect(pauseSettled).toBe(true), {
            timeout: 5000,
          });
          expect((await pause).error).toBeUndefined();
          expect(requests).toHaveLength(1);
        }
        if (gui) {
          const settled = await gui.settled;
          if (action !== "stop") expect(settled.error).toBeUndefined();
          await gui.finish();
        } else if (action === "stop") {
          // An explicit interruption uses the failure callback internally, but
          // its typed outcome must settle the managed chat to idle, not failed.
          await vi.waitFor(() => expect(f!.turnFailures).toHaveLength(1));
          expect(f.turnFailures[0]).toMatchObject({
            turnId,
            terminalStatus: "interrupted",
          });
          await vi.waitFor(async () =>
            expect(
              (
                await f!.authority.repository.getChatExecutionContext(
                  f!.authority.ownerId,
                  f!.authority.chatId,
                )
              )?.status,
            ).toBe("idle"),
          );
        } else {
          await vi.waitFor(() => expect(f!.completed).toContain(turnId), {
            timeout: 15000,
          });
        }
        if (action !== "stop") {
          await vi.waitFor(
            () => expect(f!.terminalText()).toContain("AFTER_RESUME"),
            { timeout: 15000 },
          );
          expect(f.messages).toContain("AFTER_RESUME");
        }
        const native = await f.runtime.readNativeHistory(f.threadId);
        expect(native.thread.turns).toHaveLength(1);
        expect(native.thread.turns[0]).toMatchObject({
          id: turnId,
          status: action !== "stop" ? "completed" : "interrupted",
        });
        expect(f.runtime.transportGeneration).toBe(f.generation);
        expect(f.terminalSettled()).toBe(false);
      } catch (error) {
        if (f) console.error(JSON.stringify(f.diagnostics()));
        throw error;
      } finally {
        requests.forEach(({ response }) => response.destroy());
        await f?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60000,
  );
});
