import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { killNativeTree } from "./native-process-tree-fixture.js";
import { resourceProtectionFixture } from "./native-resource-protection-fixture.js";
import { handleNativeResourceProtection } from "../src/codex/native-resource-control.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

/** Native resource policy, independently of whole-worker recovery. */
describe.skipIf(!binary)(
  "native durable suspension resource boundaries",
  () => {
    it.each([
      ["paginated", "resume"],
      ["legacy", "resume"],
      ["paginated", "stop"],
      ["legacy", "stop"],
      ["paginated", "live-completed"],
      ["legacy", "live-completed"],
      ["paginated", "cold-completed"],
      ["legacy", "cold-completed"],
      ["paginated", "cold-grant-repair"],
      ["legacy", "cold-grant-repair"],
      ["paginated", "cold-stop"],
      ["legacy", "cold-stop"],
      ["paginated", "cold-large-completed"],
      ["legacy", "cold-large-completed"],
      ["paginated", "cold-repeated-completed"],
      ["legacy", "cold-repeated-completed"],
      ["paginated", "cold-stop-during-open"],
      ["legacy", "cold-stop-during-open"],
      ["paginated", "cold-write-rejected"],
      ["legacy", "cold-write-rejected"],
    ] as const)(
      "preserves %s terminal resource behavior across %s",
      async (historyMode, action) => {
        await verifyBuiltRuntime(path.dirname(binary!));
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-durable-resource-"),
        );
        const home = path.join(directory, "home");
        const cwd = path.join(directory, "workspace");
        const requests: { body: Json; response: ServerResponse }[] = [];
        const frames: Json[] = [];
        const stderr: string[] = [];
        let child: ChildProcessWithoutNullStreams | undefined;
        let client: CodexRpcClient | undefined;
        let succeeded = false;
        let generation = "";
        let encryption: Awaited<ReturnType<typeof resourceProtectionFixture>>;
        const protectionRequests: Json[] = [];
        const controlErrors: unknown[] = [];
        let openRelease: (() => void) | undefined;
        let holdOpen = false;
        let discardedOpen = false;
        const lateResourceReplies: Json[] = [];
        const managedConfig = {
          mcpServers: {},
          developerInstructions: null,
          multiAgentEnabled: false,
          subagentModel: null,
          subagentReasoningEffort: null,
        };
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
            "event: response.created\ndata: " +
              JSON.stringify({
                type: "response.created",
                response: { id: "resource-" + requests.length },
              }) +
              "\n\n",
          );
        });
        const rpc = async (method: string, params: Json): Promise<Json> => {
          const result = await client!.request(method, params);
          if (result.error)
            throw new Error(method + ": " + JSON.stringify(result.error));
          return result.result as Json;
        };
        const startNative = async () => {
          encryption = await resourceProtectionFixture(
            path.join(directory, "encryption"),
          );
          generation = randomUUID();
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
          client = new CodexRpcClient(child, 30000);
          const ownClient = client;
          const ownGeneration = generation;
          const ownProtection = encryption.protection;
          readline
            .createInterface({ input: child.stdout })
            .on("line", (line) => {
              const frame = JSON.parse(line) as Json;
              // Private resource contents never join diagnostic or observer frames.
              if (frame.method === "thread/nativeResources/requested") {
                const request = frame.params;
                protectionRequests.push({ ...request, value: "<private>" });
                void (async () => {
                  if (!request.seal && holdOpen)
                    await new Promise<void>((resolve) => {
                      openRelease = resolve;
                    });
                  await handleNativeResourceProtection(request, {
                    owner: () =>
                      client === ownClient
                        ? { transport: ownGeneration, runner: ownGeneration }
                        : null,
                    protection: ownProtection,
                    resolve: async (params) => {
                      const result = await ownClient.request(
                        "thread/nativeResources/resolve",
                        params,
                      );
                      if (result.error && discardedOpen) {
                        lateResourceReplies.push(result);
                        return;
                      }
                      if (result.error)
                        throw new Error(JSON.stringify(result.error));
                    },
                  });
                })().catch((error) => controlErrors.push(error));
                return;
              }
              frames.push(frame);
              if (
                frame.method === "thread/managedExecution/requested" &&
                frame.params.trigger === "inference" &&
                ["begin", "begin-independent", "suspend", "resume"].includes(
                  frame.params.input.phase,
                )
              ) {
                const { threadId, runnerGeneration, attemptId, input } =
                  frame.params;
                void ownClient
                  .request("thread/managedExecution/resolve", {
                    threadId,
                    runnerGeneration,
                    attemptId,
                    operationGeneration: `inference:${input.scopeId}:${attemptId}`,
                    allow: true,
                  })
                  .then((result) => {
                    if (result.error)
                      throw new Error(JSON.stringify(result.error));
                  })
                  .catch((error) => controlErrors.push(error));
              }
            });
          await rpc("initialize", {
            clientInfo: {
              name: "cantrip_durable_resource_fixture",
              version: "1",
            },
            capabilities: { experimentalApi: true },
          });
          client.notify("initialized");
        };
        const sendTool = (
          index: number,
          name: string,
          args: Json,
          callId: string,
        ) => {
          const tools = requests[index]!.body.tools.flatMap((entry: Json) =>
            entry.type === "namespace"
              ? entry.tools.map((tool: Json) => ({
                  ...tool,
                  namespace: entry.name,
                }))
              : [entry],
          );
          const selected = tools.find((tool: Json) => tool.name === name);
          expect(
            selected,
            "native tool must actually be advertised",
          ).toBeDefined();
          const events = [
            {
              type: "response.output_item.done",
              item: {
                id: "item-" + callId,
                type: "function_call",
                call_id: callId,
                name: selected.name,
                ...(selected.namespace
                  ? { namespace: selected.namespace }
                  : {}),
                arguments: JSON.stringify(args),
              },
            },
            {
              type: "response.completed",
              response: {
                id: "response-" + callId,
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
              },
            },
          ];
          for (const event of events)
            requests[index]!.response.write(
              "event: " +
                event.type +
                "\ndata: " +
                JSON.stringify(event) +
                "\n\n",
            );
          requests[index]!.response.end();
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
              "features.goals=false",
              "features.plugins=false",
              "features.code_mode_host=false",
              "[model_providers.fixture]",
              'name="Resource fixture"',
              'base_url="http://127.0.0.1:' +
                (server.address() as { port: number }).port +
                '/v1"',
              'wire_api="responses"',
              "requires_openai_auth=false",
              "request_max_retries=0",
              "stream_max_retries=0",
            ].join("\n"),
          );
          await startNative();
          const { thread } = await rpc("thread/start", {
            cwd,
            historyMode,
            managedConfig,
          });
          const threadId = thread.id;
          await rpc("thread/managedExecution/bind", {
            threadId,
            runnerGeneration: generation,
            expectedRunnerGeneration: null,
          });
          const { turn } = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: "ORIGINAL_RESOURCE_INPUT" }],
          });
          const turnId = turn.id;
          await vi.waitFor(() => expect(requests).toHaveLength(1), {
            timeout: 15000,
          });
          if (action !== "resume" && action !== "stop") {
            sendTool(
              0,
              "exec_command",
              {
                cmd:
                  process.platform === "win32"
                    ? action === "cold-large-completed"
                      ? "Write-Output RESOURCE_STARTED; Start-Sleep -Seconds 2; [Console]::Out.Write(('M' * 1100000) + [char]10 + 'RESOURCE_UNREAD_TAIL' + [char]10); Add-Content -Path resource-counter.txt -Value done"
                      : "Write-Output RESOURCE_STARTED; Start-Sleep -Seconds 2; Write-Output RESOURCE_UNREAD_TAIL; Add-Content -Path resource-counter.txt -Value done"
                    : action === "cold-large-completed"
                      ? `printf 'RESOURCE_STARTED\\n'; sleep 2; python3 -c 'import sys; sys.stdout.write("M" * 1100000 + "\\nRESOURCE_UNREAD_TAIL\\n")'; printf 'done\\n' >> resource-counter.txt`
                      : "printf 'RESOURCE_STARTED\\n'; sleep 2; printf 'RESOURCE_UNREAD_TAIL\\n'; printf 'done\\n' >> resource-counter.txt",
                yield_time_ms: 10,
              },
              "resource-background-call",
            );
            await vi.waitFor(() => expect(requests).toHaveLength(2), {
              timeout: 15000,
            });
            const initial = requests[1]!.body.input.find(
              (item: Json) =>
                item.type === "function_call_output" &&
                item.call_id === "resource-background-call",
            );
            const sessionId = JSON.stringify(initial).match(
              /Process running with session ID (\d+)/,
            )?.[1];
            expect(
              sessionId,
              "the actual tool must yield a pollable native session",
            ).toBeDefined();
            expect(JSON.stringify(initial)).not.toContain(
              "RESOURCE_UNREAD_TAIL",
            );
            // Actual native terminal completion, rather than a timing or PID guess.
            await vi.waitFor(
              () =>
                expect(
                  frames.some(
                    (frame) =>
                      frame.method === "item/completed" &&
                      frame.params.item.id === "resource-background-call" &&
                      frame.params.item.type === "commandExecution" &&
                      frame.params.item.status === "completed",
                  ),
                ).toBe(true),
              { timeout: 15000 },
            );
            const pausing = rpc("turn/suspension", {
              threadId,
              operation: { type: "pause", turnId },
            });
            sendTool(
              1,
              "exec_command",
              {
                cmd:
                  process.platform === "win32"
                    ? "Write-Output RESOURCE_BOUNDARY"
                    : "printf RESOURCE_BOUNDARY",
                yield_time_ms: 10000,
              },
              "resource-boundary-call",
            );
            const paused = await pausing;
            expect(paused).toMatchObject({
              paused: true,
              suspension: { threadId, turnId },
            });
            const checkpointFile = path.join(
              home,
              "turn-suspensions",
              `${createHash("sha256").update(threadId).digest("hex")}.json`,
            );
            const checkpoint = JSON.parse(
              await readFile(checkpointFile, "utf8"),
            );
            const saved = JSON.parse(checkpoint.recordJson).continuation;
            expect(JSON.stringify(checkpoint)).not.toContain(
              "RESOURCE_UNREAD_TAIL",
            );
            expect(saved.resources.formatVersion).toBe(1);
            expect(JSON.stringify(saved.resources)).not.toContain(
              "RESOURCE_UNREAD_TAIL",
            );
            expect(
              protectionRequests.filter((request) => request.seal),
            ).toHaveLength(1);
            expect(
              protectionRequests.filter((request) => !request.seal),
            ).toHaveLength(0);
            if (action.startsWith("cold-")) {
              await killNativeTree(child!);
              client!.close();
              child = undefined;
              client = undefined;
              await startNative();
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).toMatchObject(paused);
              await rpc("thread/resume", {
                threadId,
                expectedSuspension: paused.suspension,
                managedConfig,
              });
              await rpc("thread/managedExecution/bind", {
                threadId,
                runnerGeneration: generation,
                expectedRunnerGeneration: null,
              });
            }
            expect(requests).toHaveLength(2);
            expect(
              protectionRequests.filter((request) => !request.seal),
            ).toHaveLength(0);
            if (action === "cold-grant-repair" || action === "cold-stop") {
              await encryption.authorize(false);
            }
            if (action === "cold-stop") {
              await rpc("turn/interrupt", { threadId, turnId });
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).toMatchObject({ paused: false, suspension: null });
              expect(requests).toHaveLength(2);
              expect(
                protectionRequests.filter((request) => !request.seal),
              ).toHaveLength(0);
              expect(controlErrors).toEqual([]);
              succeeded = true;
              return;
            }
            if (action === "cold-grant-repair") {
              await expect(
                rpc("turn/pause", { threadId, turnId, paused: false }),
              ).rejects.toThrow("chat-content encryption grant");
              expect(requests).toHaveLength(2);
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).toMatchObject(paused);
              await encryption.authorize(true);
            }
            const resume = () =>
              rpc("turn/pause", { threadId, turnId, paused: false });
            if (action === "cold-stop-during-open") {
              holdOpen = true;
              const rejected = expect(resume()).rejects.toThrow();
              await vi.waitFor(
                () => expect(openRelease).toBeTypeOf("function"),
                { timeout: 15000 },
              );
              await rpc("turn/interrupt", { threadId, turnId });
              await rejected;
              discardedOpen = true;
              openRelease!();
              await vi.waitFor(
                () => expect(lateResourceReplies).toHaveLength(1),
                { timeout: 15000 },
              );
              expect(requests).toHaveLength(2);
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).toMatchObject({ paused: false, suspension: null });
              expect(controlErrors).toEqual([]);
              succeeded = true;
              return;
            }
            if (action === "cold-completed")
              await Promise.all([resume(), resume()]);
            else await resume();
            await vi.waitFor(() => expect(requests).toHaveLength(3), {
              timeout: 15000,
            });
            let resumedIndex = 2;
            if (action === "cold-repeated-completed") {
              const pausingAgain = rpc("turn/suspension", {
                threadId,
                operation: { type: "pause", turnId },
              });
              sendTool(
                resumedIndex,
                "exec_command",
                {
                  cmd:
                    process.platform === "win32"
                      ? "Write-Output RESOURCE_SECOND_BOUNDARY"
                      : "printf RESOURCE_SECOND_BOUNDARY",
                  yield_time_ms: 10000,
                },
                "resource-second-boundary-call",
              );
              const again = await pausingAgain;
              expect(again.suspension.checkpointId).not.toBe(
                paused.suspension.checkpointId,
              );
              await killNativeTree(child!);
              client!.close();
              child = undefined;
              client = undefined;
              await startNative();
              await rpc("thread/resume", {
                threadId,
                expectedSuspension: again.suspension,
                managedConfig,
              });
              await rpc("thread/managedExecution/bind", {
                threadId,
                runnerGeneration: generation,
                expectedRunnerGeneration: null,
              });
              expect(requests).toHaveLength(3);
              await resume();
              await vi.waitFor(() => expect(requests).toHaveLength(4), {
                timeout: 15000,
              });
              resumedIndex = 3;
            }
            const restored = requests[resumedIndex]!.body.input;
            expect(
              JSON.stringify(restored).split("ORIGINAL_RESOURCE_INPUT").length -
                1,
            ).toBe(1);
            expect(
              restored.filter(
                (item: Json) =>
                  item.type === "function_call_output" &&
                  item.call_id === "resource-background-call",
              ),
            ).toHaveLength(1);
            if (action === "cold-write-rejected") {
              sendTool(
                resumedIndex,
                "write_stdin",
                {
                  session_id: Number(sessionId),
                  chars: "printf REPLAY_ATTEMPT >> resource-counter.txt\n",
                  yield_time_ms: 1000,
                },
                "resource-rejected-write-call",
              );
              await vi.waitFor(
                () => expect(requests).toHaveLength(resumedIndex + 2),
                { timeout: 15000 },
              );
              const rejected = requests[resumedIndex + 1]!.body.input.find(
                (item: Json) =>
                  item.type === "function_call_output" &&
                  item.call_id === "resource-rejected-write-call",
              );
              expect(JSON.stringify(rejected)).toContain(
                "use empty chars to read its remaining output",
              );
              expect(JSON.stringify(rejected)).not.toContain(
                "rerun exec_command",
              );
              expect(JSON.stringify(rejected)).not.toContain(
                "RESOURCE_UNREAD_TAIL",
              );
              resumedIndex++;
            }
            sendTool(
              resumedIndex,
              "write_stdin",
              {
                session_id: Number(sessionId),
                chars: "",
                yield_time_ms: 1000,
                ...(action === "cold-large-completed"
                  ? { max_output_tokens: 1000000 }
                  : {}),
              },
              "resource-poll-call",
            );
            await vi.waitFor(
              () => expect(requests).toHaveLength(resumedIndex + 2),
              {
                timeout: 15000,
              },
            );
            const polled = requests[resumedIndex + 1]!.body.input.find(
              (item: Json) =>
                item.type === "function_call_output" &&
                item.call_id === "resource-poll-call",
            );
            expect(JSON.stringify(polled)).toContain("RESOURCE_UNREAD_TAIL");
            if (action === "cold-large-completed") {
              const omitted =
                1100000 +
                Buffer.byteLength("\nRESOURCE_UNREAD_TAIL\n") -
                1024 * 1024;
              expect(JSON.stringify(polled)).toContain(
                `${omitted} bytes omitted`,
              );
            }
            expect(
              JSON.stringify(polled).split("RESOURCE_UNREAD_TAIL").length - 1,
            ).toBe(1);
            expect(
              (await readFile(path.join(cwd, "resource-counter.txt"), "utf8"))
                .trim()
                .split(/\r?\n/),
            ).toEqual(["done"]);
            await rpc("turn/interrupt", { threadId, turnId });
            await vi.waitFor(
              () =>
                expect(
                  frames.some(
                    (frame) =>
                      frame.method === "turn/completed" &&
                      frame.params.turn.id === turnId &&
                      frame.params.turn.status === "interrupted",
                  ),
                ).toBe(true),
              { timeout: 15000 },
            );
            expect(
              frames.filter((frame) => frame.method === "turn/started"),
            ).toHaveLength(1);
            expect(controlErrors).toEqual([]);
            expect(
              protectionRequests.filter((request) => !request.seal),
            ).toHaveLength(
              action === "cold-grant-repair" ||
                action === "cold-repeated-completed"
                ? 2
                : 1,
            );
            expect(
              protectionRequests.filter((request) => request.seal),
            ).toHaveLength(action === "cold-repeated-completed" ? 2 : 1);
            expect(
              frames.filter(
                (frame) =>
                  frame.method === "item/completed" &&
                  frame.params.item.id === "resource-background-call",
              ),
            ).toHaveLength(1);
            succeeded = true;
            return;
          }
          const tools = requests[0]!.body.tools.flatMap((entry: Json) =>
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
          const pause = rpc("turn/suspension", {
            threadId,
            operation: { type: "pause", turnId },
          });
          const rejection = expect(pause).rejects.toThrow(
            "background commands",
          );
          const events = [
            {
              type: "response.output_item.done",
              item: {
                id: "resource-tool",
                type: "function_call",
                call_id: "resource-background-call",
                name: command.name,
                ...(command.namespace ? { namespace: command.namespace } : {}),
                arguments: JSON.stringify({
                  cmd:
                    process.platform === "win32"
                      ? "Write-Output RESOURCE_STARTED; Start-Sleep -Seconds 30"
                      : "printf 'RESOURCE_STARTED\\n'; sleep 30",
                  yield_time_ms: 10,
                }),
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resource-first",
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
              },
            },
          ];
          for (const event of events)
            requests[0]!.response.write(
              "event: " +
                event.type +
                "\ndata: " +
                JSON.stringify(event) +
                "\n\n",
            );
          requests[0]!.response.end();
          await rejection;
          expect(requests).toHaveLength(1);
          if (action === "resume") {
            await rpc("turn/pause", { threadId, turnId, paused: false });
            await vi.waitFor(() => expect(requests).toHaveLength(2), {
              timeout: 15000,
            });
            const restored = requests[1]!.body.input;
            expect(
              JSON.stringify(restored).split("ORIGINAL_RESOURCE_INPUT").length -
                1,
            ).toBe(1);
            expect(
              restored.filter(
                (item: Json) =>
                  item.type === "function_call_output" &&
                  item.call_id === "resource-background-call",
              ),
            ).toHaveLength(1);
          }
          await rpc("turn/interrupt", { threadId, turnId });
          await vi.waitFor(
            () =>
              expect(
                frames.some(
                  (frame) =>
                    frame.method === "turn/completed" &&
                    frame.params.turn.id === turnId &&
                    frame.params.turn.status === "interrupted",
                ),
              ).toBe(true),
            { timeout: 15000 },
          );
          expect(
            frames.filter((frame) => frame.method === "turn/started"),
          ).toHaveLength(1);
          expect(requests).toHaveLength(action === "resume" ? 2 : 1);
          expect(
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "read" },
            }),
          ).toMatchObject({ paused: false });
          succeeded = true;
        } finally {
          openRelease?.();
          if (!succeeded)
            await writeFile(
              path.join(directory, "diagnostics.json"),
              JSON.stringify(
                { frames, stderr, requests: requests.map((item) => item.body) },
                null,
                2,
              ),
            );
          if (child) await killNativeTree(child);
          client?.close();
          for (const request of requests) request.response.destroy();
          server.closeAllConnections();
          if (server.listening)
            await new Promise<void>((resolve) => server.close(() => resolve()));
          if (succeeded) await rm(directory, { recursive: true, force: true });
        }
      },
      60000,
    );
  },
);
