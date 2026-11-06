import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { killNativeTree } from "./native-process-tree-fixture.js";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
const execute = promisify(execFile);
type Json = Record<string, any>;
function events(response: ServerResponse, values: Json[]) {
  for (const value of values)
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  response.end();
}
function done(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  };
}
function answer(response: ServerResponse, id: string) {
  events(response, [
    {
      type: "response.output_item.done",
      item: {
        id,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: id }],
      },
    },
    done(id),
  ]);
}

describe.skipIf(!binary || process.platform === "win32")(
  "cold worker observer on actual native processes",
  () => {
    it.each(["ide", "standalone-chat"] as const)(
      "%s: kills the entire worker tree twice and restores held original identities, context, tools and bookkeeping",
      async (executionProfile) => {
        await verifyBuiltRuntime(path.dirname(binary!));
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-cold-worker-"),
        );
        const cwd = path.join(directory, "workspace"),
          data = path.join(directory, "data"),
          home = path.join(directory, "original-home");
        const requests: { body: Json; response: ServerResponse }[] = [];
        const actors: {
          child: ChildProcess;
          messages: Json[];
          stderr: string;
          terminating: boolean;
        }[] = [];
        let succeeded = false;
        let savedTotalTokens = 0;
        const provider = createServer(async (request, response) => {
          if (!request.url?.endsWith("/responses")) {
            response.writeHead(404).end();
            return;
          }
          let text = "";
          for await (const part of request) text += part;
          requests.push({ body: JSON.parse(text), response });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `response-${requests.length}` } })}\n\n`,
          );
        });
        const launch = (extra: Json = {}) => {
          const child = fork(
            fileURLToPath(
              new URL("./native-cold-worker-fixture.ts", import.meta.url),
            ),
            [
              JSON.stringify({
                binary,
                executionProfile,
                cwd,
                data,
                home,
                provider: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
                ...extra,
              }),
            ],
            {
              cwd,
              execArgv: ["--import", import.meta.resolve("tsx")],
              stdio: ["pipe", "pipe", "pipe", "ipc"],
            },
          );
          const actor = {
            child,
            messages: [] as Json[],
            stderr: "",
            terminating: false,
          };
          child.on("message", (message) =>
            actor.messages.push(message as Json),
          );
          child.stderr?.on("data", (chunk) => {
            actor.stderr += String(chunk);
          });
          actors.push(actor);
          return actor;
        };
        const wait = async (
          actor: (typeof actors)[number],
          type: string,
          count = 1,
        ) => {
          await vi.waitFor(
            () => {
              const error = actor.messages.find(
                (message) => message.type === "error",
              );
              if (actor.child.exitCode !== null && type !== "error")
                throw new Error(
                  `Worker fixture exited ${actor.child.exitCode}: ${actor.stderr}`,
                );
              if (error && type !== "error" && !actor.terminating)
                throw new Error(error.error);
              expect(
                actor.messages.filter((message) => message.type === type)
                  .length,
              ).toBeGreaterThanOrEqual(count);
            },
            { timeout: 30_000 },
          );
          return actor.messages.filter((message) => message.type === type)[
            count - 1
          ]!;
        };
        const waitRequests = (count: number) =>
          vi.waitFor(
            () => expect(requests.length).toBeGreaterThanOrEqual(count),
            { timeout: 30_000 },
          );
        const kill = async (actor: (typeof actors)[number]) => {
          actor.terminating = true;
          if (actor.child.exitCode === null && actor.child.signalCode === null)
            await killNativeTree(actor.child as never);
        };
        try {
          await mkdir(cwd, { recursive: true });
          await mkdir(home, { recursive: true });
          await writeFile(path.join(cwd, "effect.txt"), "");
          await execute("git", ["init", "-q", cwd]);
          await execute("git", ["add", "."], { cwd });
          await execute(
            "git",
            [
              "-c",
              "user.name=Native fixture",
              "-c",
              "user.email=fixture@cantrip.invalid",
              "commit",
              "-qm",
              "initial",
            ],
            { cwd },
          );
          provider.listen(0, "127.0.0.1");
          await once(provider, "listening");
          let actor = launch();
          const original = await wait(actor, "turn");
          await waitRequests(1);
          const tools = requests[0]!.body.tools.flatMap((tool: Json) =>
            tool.type === "namespace"
              ? tool.tools.map((entry: Json) => ({
                  ...entry,
                  namespace: tool.name,
                }))
              : [tool],
          );
          const command = tools.find(
            (tool: Json) => tool.name === "exec_command",
          );
          expect(
            command,
            "native must advertise the actual command tool",
          ).toBeDefined();
          events(requests[0]!.response, [
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "effect-item",
                call_id: "effect-once",
                name: command.name,
                ...(command.namespace ? { namespace: command.namespace } : {}),
                arguments: JSON.stringify({
                  cmd: "printf 'once\\n' >> effect.txt; printf TOOL_COMPLETED_ONCE",
                  yield_time_ms: 10000,
                }),
              },
            },
            done("tool-response"),
          ]);
          await waitRequests(2);
          expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe(
            "once\n",
          );
          for (let cycle = 0; cycle < 2; cycle++) {
            actor.child.send!({
              type: "pause",
              input: `COLD_CONTINUE_${cycle}`,
            });
            await wait(actor, "input-accepted");
            answer(requests[cycle + 1]!.response, `BEFORE_COLD_PAUSE_${cycle}`);
            const paused = await wait(actor, "paused");
            expect(paused.evidence.suspension).toMatchObject({
              threadId: original.threadId,
              turnId: original.turnId,
            });
            expect(requests).toHaveLength(cycle + 2);
            // Kill starts immediately after the actual durable worker acknowledgement.
            await kill(actor);
            if (cycle === 0) {
              const denied = launch({
                storageId: paused.evidence.storageId,
                heldSuspension: paused.evidence,
                suspension: paused.evidence.suspension,
                denyGrant: true,
              });
              expect((await wait(denied, "error")).error).toMatch(
                /chat-content encryption grant/i,
              );
              expect(
                denied.messages.some(
                  (message) => message.type === "native-process",
                ),
              ).toBe(false);
              await kill(denied);
              const missing = launch({
                storageId: paused.evidence.storageId,
                heldSuspension: { ...paused.evidence, storageId: randomUUID() },
                suspension: paused.evidence.suspension,
                home: path.join(directory, "unsafe-fallback-home"),
              });
              expect((await wait(missing, "error")).error).toMatch(
                /saved suspension source is missing/,
              );
              expect(
                missing.messages.some(
                  (message) => message.type === "native-process",
                ),
              ).toBe(false);
              await kill(missing);
            }
            actor = launch({
              preparationIntent: cycle === 0 ? "preserve" : "configure",
              storageId: paused.evidence.storageId,
              // These diagnostics cannot replace actual native compatibility.
              heldSuspension:
                cycle === 0
                  ? {
                      ...paused.evidence,
                      runtimeVersion: "changed-diagnostic",
                      runtimeFingerprint: "f".repeat(64),
                    }
                  : paused.evidence,
              suspension: paused.evidence.suspension,
              home: path.join(directory, `changed-default-home-${cycle}`),
            });
            const restored = await wait(actor, "restored");
            expect(restored).toMatchObject({
              threadId: original.threadId,
              turnId: original.turnId,
              starts: 0,
              home,
              sourceHome: home,
            });
            expect(restored.baseline).toEqual(restored.expectedBaseline);
            expect(restored.latestUsage).toEqual(restored.expectedLatestUsage);
            expect(restored.contextUsage).toEqual(
              restored.expectedContextUsage,
            );
            // Pause may cancel the in-flight response before its usage is
            // accepted. Preserve accounting actually committed by native.
            expect(
              restored.contextUsage.total.totalTokens,
            ).toBeGreaterThanOrEqual(Math.max(13, savedTotalTokens));
            savedTotalTokens = restored.contextUsage.total.totalTokens;
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(requests).toHaveLength(cycle + 2);
            expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe(
              "once\n",
            );
            actor.child.send!({ type: "resume" });
            expect((await wait(actor, "resumed")).active).toEqual({
              threadId: original.threadId,
              turnId: original.turnId,
            });
            await waitRequests(cycle + 3);
            const request = requests[cycle + 2]!.body;
            expect(request.model).toBe(requests[0]!.body.model);
            expect(request.reasoning).toEqual(requests[0]!.body.reasoning);
            expect(
              JSON.stringify(request.input).split("ORIGINAL_COLD_INPUT"),
            ).toHaveLength(2);
            expect(
              request.input.filter(
                (item: Json) =>
                  ["function_call_output", "custom_tool_call_output"].includes(
                    item.type,
                  ) && item.call_id === "effect-once",
              ),
            ).toHaveLength(1);
            expect(JSON.stringify(request.input)).toContain(
              `COLD_CONTINUE_${cycle}`,
            );
          }
          answer(requests[3]!.response, "AFTER_COLD_RESUME");
          const completed = await wait(actor, "completed");
          expect(completed.result).toMatchObject({
            threadId: original.threadId,
            turnId: original.turnId,
            text: "AFTER_COLD_RESUME",
            status: "completed",
          });
          expect(completed.starts).toBe(0);
          expect(completed.result.measuredUsage).toMatchObject({
            totalTokens: 13,
            inputTokens: 10,
            outputTokens: 3,
          });
          const usage = completed.activities
            .filter((activity: Json) => activity.type === "usage")
            .at(-1);
          expect(usage.total).toMatchObject({
            totalTokens: savedTotalTokens + 13,
          });
          expect(completed.history.thread.turns).toHaveLength(1);
          expect(completed.history.thread.turns[0]).toMatchObject({
            id: original.turnId,
            status: "completed",
          });
          expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe(
            "once\n",
          );
          expect(
            completed.activities.some(
              (activity: Json) =>
                activity.type === "fileChange" &&
                activity.changes.some((change: Json) =>
                  change.path.endsWith("effect.txt"),
                ),
            ),
          ).toBe(true);
          succeeded = true;
        } finally {
          for (const actor of actors) await kill(actor);
          for (const request of requests) request.response.destroy();
          provider.closeAllConnections();
          if (provider.listening)
            await new Promise<void>((resolve) =>
              provider.close(() => resolve()),
            );
          if (succeeded) await rm(directory, { recursive: true, force: true });
          else
            await writeFile(
              path.join(directory, "diagnostics.json"),
              JSON.stringify(
                {
                  actors: actors.map(({ messages, stderr }) => ({
                    messages,
                    stderr,
                  })),
                  requests: requests.map(({ body }) => body),
                },
                null,
                2,
              ),
            );
        }
      },
      150_000,
    );
  },
);
