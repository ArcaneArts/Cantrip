import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
const helper = process.env.CANTRIP_CUA_TEST_BINARY?.trim();
type Frame = Record<string, any>;
function toolsOf(body: Frame): Frame[] {
  return (
    body.tools?.flatMap((tool: Frame) =>
      tool.type === "namespace"
        ? tool.tools.map((entry: Frame) => ({ ...entry, namespace: tool.name }))
        : [tool],
    ) ?? []
  );
}
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
function answer(response: ServerResponse, id: string) {
  send(response, id, {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: id }],
  });
}
function invoke(
  response: ServerResponse,
  id: string,
  tool: Frame,
  args: Frame,
) {
  send(response, id, {
    type: "function_call",
    call_id: id,
    name: tool.name,
    namespace: tool.namespace,
    arguments: JSON.stringify(args),
  });
}

describe.skipIf(!binary || !helper)(
  "native child computer-use authority",
  () => {
    it.each(["gui", "terminal"] as const)(
      "scopes children of %s turns through completion, Stop, and the next turn",
      async (origin) => {
        const spawned = new Set<number>();
        const issued = new Set<number>();
        const roots = new Map<number, ServerResponse>();
        const releasedRoots = new Set<number>();
        const childOutputs = new Map<number, Frame>();
        const modelErrors: string[] = [];
        const responses: ServerResponse[] = [];
        const inventories: string[][] = [];
        const server = createServer(async (request, response) => {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          if (!request.url?.startsWith("/v1/")) {
            response.writeHead(404).end();
            return;
          }
          responses.push(response);
          const body = JSON.parse(raw);
          const lastUser = JSON.stringify(
            body.input?.findLast(
              (item: Frame) =>
                item.role === "user" &&
                /(?:CHILD|ROOT)_CUA_\d+/.test(JSON.stringify(item)),
            ),
          );
          const child = lastUser?.match(/CHILD_CUA_(\d+)/);
          const index = Number(
            (child ?? lastUser?.match(/ROOT_CUA_(\d+)/))?.[1],
          );
          const inventory = toolsOf(body);
          inventories.push(
            inventory.map((tool) => `${tool.namespace ?? ""}.${tool.name}`),
          );
          const fail = (message: string) => {
            modelErrors.push(message);
            response.writeHead(400).end(message);
          };
          if (![1, 2, 3].includes(index))
            return fail(`Unrecognized native input: ${lastUser}`);
          if (!child && !spawned.has(index)) {
            const tool = inventory.find((tool) =>
              tool.name?.endsWith("spawn_agent"),
            );
            if (!tool) return fail("Native parent has no spawn tool");
            spawned.add(index);
            const fields = tool.parameters?.properties ?? {};
            invoke(response, `spawn-child-${index}`, tool, {
              message: `CHILD_CUA_${index}: inspect the synthetic window.`,
              ...(fields.task_name ? { task_name: `cua_child_${index}` } : {}),
              ...(fields.fork_turns ? { fork_turns: "none" } : {}),
              ...(fields.fork_context ? { fork_context: false } : {}),
            });
          } else if (!child) {
            if (releasedRoots.has(index)) {
              answer(response, `ROOT_RESULT_${index}`);
              return;
            }
            roots.set(index, response);
            // Keep the root's real provider request active while the child uses CUA.
            // The test releases this response only after checking child authority.
          } else if (!issued.has(index)) {
            const tool = inventory.find(
              (tool) =>
                (tool.namespace?.includes("cantrip_cua") &&
                  tool.name === "js") ||
                tool.name === "mcp__cantrip_cua__js",
            );
            if (!tool) return fail("Native child has no CUA JS tool");
            issued.add(index);
            invoke(response, `child-cua-${index}`, tool, {
              script: `await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.moveCursor({x:${index * 10},y:30}); await cua.snapshot(); ${index === 2 ? "for(let i=0;i<15;i++) await cua.wait(10000);" : ""} 'child-cua-${index}'`,
            });
          } else {
            childOutputs.set(index, body);
            answer(response, `CHILD_RESULT_${index}`);
          }
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
          const cua = f.cua!;
          const rootTurns = new Set<string>();
          const childTurns = new Set<string>();
          for (const index of [1, 2, 3]) {
            const gui =
              origin === "gui"
                ? await f.guiStart(
                    `ROOT_CUA_${index}: spawn the synthetic child.`,
                  )
                : undefined;
            if (!gui)
              await f.tuiSend(`ROOT_CUA_${index}: spawn the synthetic child.`);
            await vi.waitFor(
              () => {
                expect(modelErrors).toEqual([]);
                expect(cua.calls).toHaveLength(index);
                expect(roots.has(index)).toBe(true);
                expect(
                  cua.activities.some(
                    (activity) =>
                      activity.operation === "observation.snapshot" &&
                      activity.outcome === "completed" &&
                      activity.binding.turnId ===
                        cua.calls[index - 1]!.args[1].turnId,
                  ),
                ).toBe(true);
              },
              { timeout: 20000 },
            );
            const call = cua.calls[index - 1]!;
            const request = call.args[1];
            expect(request.threadId).not.toBe(f.threadId);
            expect(childTurns.has(request.turnId)).toBe(false);
            childTurns.add(request.turnId);
            const parent = (
              await f.runtime.readNativeHistory(f.threadId)
            ).thread.turns.at(-1)!;
            expect(parent.status).toBe("inProgress");
            expect(rootTurns.has(parent.id)).toBe(false);
            rootTurns.add(parent.id);
            expect(call.observedExecution).toMatchObject({
              rootThreadId: f.threadId,
              rootTurnId: parent.id,
              parentThreadId: f.threadId,
              threadId: request.threadId,
              turnId: request.turnId,
              agentScope: { isRoot: false, depth: 1 },
            });
            const execution = f.runtime.resolveComputerUseExecution({
              chatId: f.authority.chatId,
              threadId: request.threadId,
              turnId: request.turnId,
            });
            if (index === 2) {
              expect(call.result).toBeUndefined();
              expect(call.error).toBeUndefined();
              expect(execution).toMatchObject({
                rootThreadId: f.threadId,
                rootTurnId: parent.id,
                parentThreadId: f.threadId,
                threadId: request.threadId,
                turnId: request.turnId,
              });
              expect(execution?.agentScope?.isRoot).toBe(false);
              if (gui) f.tuiStop();
              else expect(await f.guiStop()).toEqual({ interrupted: true });
              await vi.waitFor(() => expect(call.error).toBeTruthy(), {
                timeout: 5000,
              });
              expect(execution!.signal.aborted).toBe(true);
              if (gui) {
                const settled = await gui.settled;
                expect(settled.error).toBeTruthy();
                await gui.finish();
              } else
                await vi.waitFor(
                  () => expect(f!.turnFailures).toHaveLength(1),
                  { timeout: 10000 },
                );
              await vi.waitFor(
                async () =>
                  expect(
                    (
                      await f!.runtime.readNativeHistory(f!.threadId)
                    ).thread.turns.at(-1)?.status,
                  ).toBe("interrupted"),
                { timeout: 10000 },
              );
              expect(
                f.authority.phases.some(
                  (phase) =>
                    phase.phase === "admit" &&
                    phase.body.origin === (gui ? "terminal" : "gui") &&
                    phase.body.method === "turn/interrupt" &&
                    phase.body.intent.expectedTurnId === parent.id,
                ),
              ).toBe(true);
            } else {
              await vi.waitFor(
                () => expect(childOutputs.has(index)).toBe(true),
                { timeout: 15000 },
              );
              expect(call.error).toBeUndefined();
              expect(call.result?.isError).not.toBe(true);
              const output = childOutputs
                .get(index)!
                .input.filter(
                  (item: Frame) =>
                    item.type === "function_call_output" &&
                    item.call_id === `child-cua-${index}`,
                )
                .flatMap((item: Frame) => item.output);
              expect(output).toContainEqual(
                expect.objectContaining({
                  type: "input_image",
                  image_url: expect.stringMatching(/^data:image\/png;base64,/),
                }),
              );
              await vi.waitFor(
                async () =>
                  expect(
                    (
                      await f!.runtime.readNativeHistory(request.threadId)
                    ).thread.turns.at(-1)?.status,
                  ).toBe("completed"),
                { timeout: 15000 },
              );
              expect(
                f.runtime.resolveComputerUseExecution({
                  chatId: f.authority.chatId,
                  threadId: request.threadId,
                  turnId: request.turnId,
                }),
              ).toBeNull();
              expect(
                f.runtime.resolveComputerUseExecution({
                  chatId: f.authority.chatId,
                  threadId: f.threadId,
                  turnId: parent.id,
                }),
              ).not.toBeNull();
              cua.assertRetired(index - 1);
              releasedRoots.add(index);
              answer(roots.get(index)!, `ROOT_RESULT_${index}`);
              if (gui) {
                const settled = await gui.settled;
                expect(settled.error).toBeUndefined();
                expect(settled.result?.turnId).toBe(parent.id);
                await gui.finish();
              } else
                await vi.waitFor(
                  () => expect(f!.completed).toContain(parent.id),
                  { timeout: 10000 },
                );
              await vi.waitFor(
                () =>
                  expect(f!.terminalText()).toContain(`ROOT_RESULT_${index}`),
                { timeout: 10000 },
              );
              expect(f.messages).toContain(`ROOT_RESULT_${index}`);
            }
            cua.assertRetired(index - 1);
            expect(
              f.runtime.resolveComputerUseExecution({
                chatId: f.authority.chatId,
                threadId: request.threadId,
                turnId: request.turnId,
              }),
            ).toBeNull();
            await vi.waitFor(
              async () =>
                expect(
                  await f!.authority.repository.getChatExecutionContext(
                    f!.authority.ownerId,
                    f!.authority.chatId,
                  ),
                ).toMatchObject({
                  status: "idle",
                  executionLaneId: null,
                }),
              { timeout: 10000 },
            );
          }
          expect(rootTurns.size).toBe(3);
          expect(childTurns.size).toBe(3);
          expect(f.children).toHaveLength(1);
          expect(f.runtime.transportGeneration).toBe(f.generation);
          expect(f.terminalSettled()).toBe(false);
          expect(modelErrors).toEqual([]);
        } catch (error) {
          throw new Error(
            `${String(error)}; ${JSON.stringify({
              modelErrors,
              inventories,
              calls: f?.cua?.calls.map((call) => ({
                request: call.args[1],
                observed: call.observedExecution,
                error: String(call.error),
                result: call.result?.content.filter(
                  (item) => item.type === "text",
                ),
              })),
              fixture: f?.diagnostics(),
            })}`,
            { cause: error },
          );
        } finally {
          for (const response of responses) response.destroy();
          await f?.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      90000,
    );
  },
);
