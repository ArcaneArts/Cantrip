import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { killNativeTree } from "./native-process-tree-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

function send(response: ServerResponse, events: Json[]) {
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function completed(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  };
}

/** Actual native Goal bookkeeping; whole-worker recovery is a separate fixture. */
describe.skipIf(!binary)("durable native Goal accounting", () => {
  it.each([
    ["paginated", "live"],
    ["legacy", "live"],
    ["paginated", "cold"],
    ["legacy", "cold"],
    ["paginated", "cold-edited"],
    ["legacy", "cold-edited"],
    ["paginated", "cold-repeat"],
    ["legacy", "cold-repeat"],
    ["paginated", "cold-unflushed"],
    ["legacy", "cold-unflushed"],
    ["paginated", "cold-stop"],
    ["legacy", "cold-stop"],
    ["paginated", "cold-repaired-stop"],
    ["legacy", "cold-repaired-stop"],
    ["paginated", "cold-incompatible-stop"],
    ["legacy", "cold-incompatible-stop"],
  ] as const)(
    "preserves the original Goal turn with %s history across %s resume",
    async (historyMode, mode) => {
      await verifyBuiltRuntime(path.dirname(binary!));
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-durable-goal-"),
      );
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "workspace");
      const requests: { body: Json; response: ServerResponse }[] = [];
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
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `goal-${requests.length}` } })}\n\n`,
        );
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let client: CodexRpcClient | undefined;
      let frames: Json[] = [];
      const allFrames: Json[][] = [];
      const stderr: string[] = [];
      let succeeded = false;
      const rpc = async (method: string, params: Json): Promise<Json> => {
        const result = await client!.request(method, params);
        if (result.error)
          throw new Error(`${method}: ${JSON.stringify(result.error)}`);
        return result.result as Json;
      };
      const start = async () => {
        child = spawn(binary!, ["app-server"], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CODEX_HOME: home,
            OPENAI_API_KEY: "fixture-only",
          },
          stdio: "pipe",
        });
        child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
        frames = [];
        allFrames.push(frames);
        const ownFrames = frames;
        client = new CodexRpcClient(child, 30000);
        readline
          .createInterface({ input: child.stdout })
          .on("line", (line) => ownFrames.push(JSON.parse(line)));
        await rpc("initialize", {
          clientInfo: { name: "cantrip_durable_goal_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
      };
      const kill = async () => {
        if (child) await killNativeTree(child);
        client?.close();
        child = undefined;
        client = undefined;
      };
      try {
        await Promise.all([mkdir(home), mkdir(cwd)]);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        await writeFile(
          path.join(home, "config.toml"),
          [
            'model="gpt-5"',
            'model_provider="fixture"',
            'approval_policy="never"',
            'sandbox_mode="danger-full-access"',
            'model_reasoning_effort="low"',
            "features.goals=true",
            "features.plugins=false",
            "features.code_mode_host=false",
            "[model_providers.fixture]",
            'name="Goal fixture"',
            `base_url="http://127.0.0.1:${(server.address() as { port: number }).port}/v1"`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            "request_max_retries=0",
            "stream_max_retries=0",
          ].join("\n"),
        );
        const cycles = mode === "cold-repeat" ? 3 : 1;
        const stops = mode.endsWith("stop");
        const unflushed = mode === "cold-unflushed" || stops;
        const tokenBudget = cycles === 3 ? 50 : unflushed ? 35 : 20;
        await start();
        const { thread } = await rpc("thread/start", { cwd, historyMode });
        const threadId = thread.id;
        await rpc("thread/goal/set", {
          threadId,
          origin: "user",
          objective: "Complete this native turn with durable accounting",
          status: "paused",
          tokenBudget,
        });
        expect(requests).toHaveLength(0);
        const turn = await rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: "ORIGINAL_DURABLE_GOAL_INPUT" }],
        });
        const turnId = turn.turn.id;
        await vi.waitFor(() => expect(requests).toHaveLength(1), {
          timeout: 15000,
        });
        await rpc("thread/goal/set", {
          threadId,
          origin: "user",
          status: "active",
        });
        for (let cycle = 0; cycle < cycles; cycle++) {
          const pausing = rpc("turn/suspension", {
            threadId,
            operation: { type: "pause", turnId },
          });
          const request = requests[cycle]!;
          const tools = request.body.tools.flatMap((entry: Json) =>
            entry.type === "namespace"
              ? entry.tools.map((tool: Json) => ({
                  ...tool,
                  namespace: entry.name,
                }))
              : [entry],
          );
          const command = tools.find(
            (tool: Json) => tool.name === "exec_command",
          );
          expect(command).toBeDefined();
          send(request.response, [
            {
              type: "response.output_item.done",
              item: {
                id: `goal-tool-${cycle}`,
                type: "function_call",
                call_id: `goal-completed-effect-${cycle}`,
                name: command.name,
                ...(command.namespace ? { namespace: command.namespace } : {}),
                arguments: JSON.stringify({
                  cmd:
                    process.platform === "win32"
                      ? "Add-Content -Path goal-counter.txt -Value 'done'"
                      : "printf 'done\\n' >> goal-counter.txt",
                  yield_time_ms: 10000,
                }),
              },
            },
            completed(`goal-tool-response-${cycle}`),
          ]);
          const paused = await pausing;
          expect(paused).toMatchObject({
            paused: true,
            suspension: { threadId, turnId },
          });
          if (mode === "cold-edited") {
            // Actual Goal mutation while held must not bill paused time, reset
            // the original turn's accounting, or invalidate its safe boundary.
            const beforeEdit = (await rpc("thread/goal/get", { threadId }))
              .goal;
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const edited = await rpc("thread/goal/set", {
              threadId,
              origin: "user",
              tokenBudget,
            });
            expect(edited.goal.tokensUsed).toBe(beforeEdit.tokensUsed);
            expect(edited.goal.timeUsedSeconds).toBe(
              beforeEdit.timeUsedSeconds,
            );
          }
          // Ordinary cold cases terminate immediately after durable confirmation.
          if (mode !== "live") {
            await kill();
            await start();
            expect(
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              }),
            ).toMatchObject(paused);
            await rpc("thread/resume", {
              threadId,
              expectedSuspension: paused.suspension,
            });
            expect(
              frames.filter((frame) => frame.method === "turn/started"),
            ).toHaveLength(0);
          }
          const capturedGoal = (await rpc("thread/goal/get", { threadId }))
            .goal;
          expect(capturedGoal).toMatchObject({
            status: "active",
            tokensUsed: 13 * (cycle + 1),
            tokenBudget,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(requests).toHaveLength(cycle + 1);
          expect((await rpc("thread/goal/get", { threadId })).goal).toEqual(
            capturedGoal,
          );
          await rpc("turn/pause", { threadId, turnId, paused: false });
          await vi.waitFor(() => expect(requests).toHaveLength(cycle + 2), {
            timeout: 15000,
          });
          const restored = requests[cycle + 1]!.body;
          expect(restored.model).toBe(requests[0]!.body.model);
          expect(restored.reasoning).toEqual(requests[0]!.body.reasoning);
          expect(
            JSON.stringify(restored.input).split("ORIGINAL_DURABLE_GOAL_INPUT")
              .length - 1,
          ).toBe(1);
          for (
            let completedCycle = 0;
            completedCycle <= cycle;
            completedCycle++
          ) {
            expect(
              restored.input.filter(
                (item: Json) =>
                  item.type === "function_call_output" &&
                  item.call_id === `goal-completed-effect-${completedCycle}`,
              ),
            ).toHaveLength(1);
          }
        }
        let finalRequest = cycles;
        if (unflushed) {
          // The real Goal injection path accepts pending input without cancelling
          // the held provider stream. Its following tool-free step leaves usage
          // unflushed at the next safe boundary.
          await rpc("thread/goal/set", {
            threadId,
            origin: "automatic",
            objective: "UPDATED_DURABLE_GOAL_OBJECTIVE",
            status: "active",
          });
          const pausing = rpc("turn/suspension", {
            threadId,
            operation: { type: "pause", turnId },
          });
          send(requests[cycles]!.response, [
            {
              type: "response.output_item.done",
              item: {
                id: "unflushed-goal-item",
                type: "message",
                role: "assistant",
                phase: "commentary",
                content: [
                  { type: "output_text", text: "UNFLUSHED_GOAL_BOUNDARY" },
                ],
              },
            },
            completed("unflushed-goal-response"),
          ]);
          const paused = await pausing;
          await kill();
          const checkpointFile = path.join(
            home,
            "turn-suspensions",
            `${createHash("sha256").update(threadId).digest("hex")}.json`,
          );
          let original: Buffer | undefined;
          let damaged: Buffer | undefined;
          if (
            mode === "cold-repaired-stop" ||
            mode === "cold-incompatible-stop"
          ) {
            original = await readFile(checkpointFile);
            const envelope = JSON.parse(original.toString());
            const record = JSON.parse(envelope.recordJson);
            const goal = record.continuation.extensions.find(
              (state: Json) => state.key === "codex.goal.accounting",
            );
            expect(goal).toBeDefined();
            goal.payload.version = 999;
            envelope.recordJson = JSON.stringify(record);
            envelope.sha256 = createHash("sha256")
              .update(envelope.recordJson)
              .digest("hex");
            damaged = Buffer.from(JSON.stringify(envelope));
            await writeFile(checkpointFile, damaged);
          }
          await start();
          await rpc("thread/resume", {
            threadId,
            expectedSuspension: paused.suspension,
          });
          expect(
            (await rpc("thread/goal/get", { threadId })).goal,
          ).toMatchObject({ tokensUsed: 13, tokenBudget });
          expect(requests).toHaveLength(cycles + 1);
          if (damaged) {
            await expect(
              rpc("turn/suspension", {
                threadId,
                operation: { type: "resume", suspension: paused.suspension },
              }),
            ).rejects.toThrow(/unsupported Goal continuation version 999/i);
            expect(await readFile(checkpointFile)).toEqual(damaged);
            expect(requests).toHaveLength(cycles + 1);
            if (mode === "cold-repaired-stop") {
              // Stop must reconstruct cancellation bookkeeping from the repair
              // without requiring an intervening successful Resume.
              await writeFile(checkpointFile, original!);
            }
          }
          if (stops) {
            await rpc("turn/interrupt", { threadId, turnId });
            const expectedTokens = mode === "cold-incompatible-stop" ? 13 : 26;
            expect(
              (await rpc("thread/goal/get", { threadId })).goal,
            ).toMatchObject({ tokensUsed: expectedTokens, tokenBudget });
            if (mode === "cold-incompatible-stop") {
              const prefix =
                path.basename(checkpointFile, ".json") + ".retired-";
              const retired = await Promise.all(
                (await readdir(path.dirname(checkpointFile)))
                  .filter((name) => name.startsWith(prefix))
                  .map((name) =>
                    readFile(path.join(path.dirname(checkpointFile), name)),
                  ),
              );
              expect(retired.some((bytes) => bytes.equals(damaged!))).toBe(
                true,
              );
              expect(JSON.stringify(frames)).toMatch(
                /preserve unsupported continuation data for inspection/i,
              );
            }
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                })
              ).suspension,
            ).toBeNull();
            // Retrying cancellation must not charge the restored delta twice.
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "discard", turnId },
            });
            expect(
              (await rpc("thread/goal/get", { threadId })).goal.tokensUsed,
            ).toBe(expectedTokens);
            await kill();
            await start();
            await rpc("thread/resume", { threadId });
            expect(
              (await rpc("thread/goal/get", { threadId })).goal.tokensUsed,
            ).toBe(expectedTokens);
            expect(requests).toHaveLength(cycles + 1);
            expect(
              allFrames
                .flat()
                .filter((frame) => frame.method === "turn/started"),
            ).toHaveLength(1);
            const stoppedHistory = await rpc("thread/read", {
              threadId,
              includeTurns: true,
            });
            expect(stoppedHistory.thread.turns).toHaveLength(1);
            expect(stoppedHistory.thread.turns[0]).toMatchObject({
              id: turnId,
              status: "interrupted",
            });
            expect(
              (
                await readFile(path.join(cwd, "goal-counter.txt"), "utf8")
              ).trim(),
            ).toBe("done");
            // A new explicit Goal resume remains usable after Stop. Opening the
            // chat alone above must never have supplied this execution intent.
            await rpc("thread/goal/set", {
              threadId,
              origin: "user",
              status: "active",
              tokenBudget: expectedTokens + 1,
            });
            await vi.waitFor(() => expect(requests).toHaveLength(cycles + 2), {
              timeout: 15000,
            });
            const restarted = frames.find(
              (frame) => frame.method === "turn/started",
            )!;
            expect(restarted.params.turn.id).not.toBe(turnId);
            send(requests[cycles + 1]!.response, [
              {
                type: "response.output_item.done",
                item: {
                  id: "explicit-goal-restart",
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "EXPLICIT_GOAL_RESTART" },
                  ],
                },
              },
              completed("explicit-goal-restart-response"),
            ]);
            await vi.waitFor(
              () =>
                expect(
                  frames.some(
                    (frame) =>
                      frame.method === "turn/completed" &&
                      frame.params.turn.id === restarted.params.turn.id,
                  ),
                ).toBe(true),
              { timeout: 15000 },
            );
            expect(
              (await rpc("thread/goal/get", { threadId })).goal.tokensUsed,
            ).toBe(expectedTokens + 13);
            expect(requests).toHaveLength(cycles + 2);
            succeeded = true;
            return;
          }
          await rpc("turn/pause", { threadId, turnId, paused: false });
          finalRequest++;
          await vi.waitFor(
            () => expect(requests).toHaveLength(finalRequest + 1),
            { timeout: 15000 },
          );
          expect(
            JSON.stringify(requests[finalRequest]!.body.input).split(
              "UPDATED_DURABLE_GOAL_OBJECTIVE",
            ).length - 1,
          ).toBe(1);
        }
        send(requests[finalRequest]!.response, [
          {
            type: "response.output_item.done",
            item: {
              id: "goal-final",
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "GOAL_ORIGINAL_TURN_COMPLETED" },
              ],
            },
          },
          completed("goal-final-response"),
        ]);
        await vi.waitFor(
          () =>
            expect(
              frames.find(
                (frame) =>
                  frame.method === "turn/completed" &&
                  frame.params.turn.id === turnId,
              )?.params.turn.status,
            ).toBe("completed"),
          { timeout: 15000 },
        );
        expect((await rpc("thread/goal/get", { threadId })).goal).toMatchObject(
          {
            status: "budgetLimited",
            tokensUsed: 13 * (finalRequest + 1),
            tokenBudget,
          },
        );
        expect(
          allFrames.flat().filter((frame) => frame.method === "turn/started"),
        ).toHaveLength(1);
        expect(requests).toHaveLength(finalRequest + 1);
        expect(
          (await readFile(path.join(cwd, "goal-counter.txt"), "utf8"))
            .trim()
            .split(/\r?\n/),
        ).toEqual(Array(cycles).fill("done"));
        const history = await rpc("thread/read", {
          threadId,
          includeTurns: true,
        });
        expect(history.thread.turns).toHaveLength(1);
        expect(history.thread.turns[0]).toMatchObject({
          id: turnId,
          status: "completed",
        });
        succeeded = true;
      } finally {
        await kill();
        requests.forEach(({ response }) => response.destroy());
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (succeeded) await rm(directory, { recursive: true, force: true });
        else {
          await writeFile(
            path.join(directory, "diagnostics.json"),
            JSON.stringify(
              {
                frames: allFrames,
                stderr,
                requests: requests.map(({ body }) => body),
              },
              null,
              2,
            ),
          );
          console.error(`Retained failed native Goal fixture: ${directory}`);
        }
      }
    },
    60000,
  );
});
