import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
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
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe.skipIf(!binary)("shared native interaction replies", () => {
  it.each([
    { origin: "gui", kind: "question" },
    { origin: "terminal", kind: "question" },
    { origin: "gui", kind: "approval" },
    { origin: "terminal", kind: "approval" },
  ] as const)(
    "answers a $kind from a $origin turn through the opposite view",
    async ({ origin, kind }) => {
      const requests: Frame[] = [];
      const errors: string[] = [];
      const responses: ServerResponse[] = [];
      const question = "Choose a shared fixture option.";
      const answer = "SHARED_INTERACTION_DONE";
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        responses.push(response);
        const body = JSON.parse(raw);
        requests.push(body);
        if (requests.length > 1) {
          send(response, "final", {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer }],
          });
          return;
        }
        const tools = body.tools.flatMap((tool: Frame) =>
          tool.type === "namespace"
            ? tool.tools.map((entry: Frame) => ({
                ...entry,
                namespace: tool.name,
              }))
            : [tool],
        );
        const name =
          kind === "question" ? "request_user_input" : "exec_command";
        const tool = tools.find((entry: Frame) => entry.name === name);
        if (!tool) {
          errors.push(
            `Missing ${name}: ${JSON.stringify(tools.map((t: Frame) => t.name))}`,
          );
          response.writeHead(400).end();
          return;
        }
        send(response, "interaction", {
          type: "function_call",
          call_id: "interaction-call",
          name: tool.name,
          namespace: tool.namespace,
          arguments: JSON.stringify(
            kind === "question"
              ? {
                  questions: [
                    {
                      id: "choice",
                      header: "Choice",
                      question,
                      options: [
                        {
                          label: "First",
                          description: "First fixture option.",
                        },
                        {
                          label: "Second",
                          description: "Second fixture option.",
                        },
                      ],
                    },
                  ],
                }
              : {
                  cmd: "/bin/echo SHARED_APPROVAL_OK",
                  shell: "/bin/sh",
                  login: false,
                  sandbox_permissions: "require_escalated",
                  justification:
                    "Run the harmless shared approval fixture echo.",
                  max_output_tokens: 100,
                },
          ),
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
          { planMode: kind === "question" ? "plan" : "default" },
        );
        expect(f.preparedMode).toBe(kind === "question" ? "plan" : "default");
        expect(f.attachedMode).toBe(f.preparedMode);
        const prompt = `Run the shared ${kind} fixture.`;
        const gui = origin === "gui" ? await f.guiStart(prompt) : undefined;
        if (!gui) await f.tuiSend(prompt);
        await vi.waitFor(
          () => {
            expect(errors).toEqual([]);
            expect(f!.interactionRequests).toHaveLength(1);
            expect(f!.terminalText()).toContain(
              kind === "question"
                ? question
                : "Press enter to confirm or esc to cancel",
            );
          },
          { timeout: 20000 },
        );
        const pending = f.interactionRequests[0]!;
        expect(pending.threadId).toBe(f.threadId);
        expect(pending.payload.kind).toBe(
          kind === "question" ? "userInput" : "commandExecution",
        );
        expect(requests).toHaveLength(1);
        const reply =
          kind === "question"
            ? {
                kind: "userInput" as const,
                answers: { choice: { answers: ["First"] } },
              }
            : {
                kind: "commandExecution" as const,
                decision: "accept" as const,
                execpolicyAmendment: null,
                networkPolicyAmendment: null,
              };
        await expect(
          f.runtime.answerAgentInteraction(pending.requestKey, {
            kind: "fileChange",
            decision: "accept",
          }),
        ).rejects.toThrow("response kind does not match");
        expect(f.interactionCleared).toEqual([]);
        expect(requests).toHaveLength(1);
        if (gui) f.tuiInput("\r");
        else await f.runtime.answerAgentInteraction(pending.requestKey, reply);
        await vi.waitFor(() => expect(requests).toHaveLength(2), {
          timeout: 10000,
        });
        const output = requests[1]!.input.filter(
          (item: Frame) =>
            item.type === "function_call_output" &&
            item.call_id === "interaction-call",
        );
        expect(JSON.stringify(output)).toContain(
          kind === "question" ? "First" : "SHARED_APPROVAL_OK",
        );
        await vi.waitFor(
          () => {
            expect(f!.interactionCleared).toEqual([pending.requestKey]);
            expect(f!.terminalText()).toContain(answer);
          },
          { timeout: 10000 },
        );
        expect(f.interactionExpired).toEqual([]);
        await expect(
          f.runtime.answerAgentInteraction(pending.requestKey, reply),
        ).rejects.toThrow("no longer pending");
        const replies = [...f.authority.receipts.values()].filter(
          (receipt) => receipt.method === "serverRequest/reply",
        );
        expect(replies).toHaveLength(1);
        expect(
          f.authority.phases.filter(
            (phase) =>
              phase.phase === "admit" &&
              phase.body.method === "serverRequest/reply",
          ),
        ).toEqual([
          expect.objectContaining({
            status: 200,
            body: expect.objectContaining({ origin: gui ? "terminal" : "gui" }),
          }),
        ]);
        if (gui) {
          expect((await gui.settled).error).toBeUndefined();
          await gui.finish();
        } else
          await vi.waitFor(
            () => expect(f!.completed).toEqual([pending.turnId]),
            { timeout: 10000 },
          );
        expect(f.messages).toContain(answer);
        expect(f.turnFailures).toEqual([]);
        expect(f.children).toHaveLength(1);
        expect(f.runtime.transportGeneration).toBe(f.generation);
        expect(f.terminalSettled()).toBe(false);
      } catch (error) {
        throw new Error(
          `${String(error)}; ${JSON.stringify({ errors, requests: requests.map((body) => body.input.filter((item: Frame) => item.type === "function_call" || item.type === "function_call_output")), pending: f?.interactionRequests, cleared: f?.interactionCleared, screen: f?.terminalText(), fixture: f?.diagnostics() })}`,
          { cause: error },
        );
      } finally {
        responses.forEach((response) => response.destroy());
        await f?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60000,
  );
});
