import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { endpointProviderKinds } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import {
  CodexAppServer,
  CodexTurnFailureError,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { normalizeEndpointModel } from "../src/endpoint-models.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

// Uses the actual pinned executable and Cantrip's production provider/operation
// configuration against a synthetic HTTP endpoint. This is not a real-backend benchmark.
describe.skipIf(!binary)("native endpoint provider connections", () => {
  it.each(["ollama", ...endpointProviderKinds] as const)(
    "completes an operation through %s without account credentials",
    async (kind) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "cantrip-native-endpoint-"),
      );
      const home = path.join(root, "home");
      const bodies: Record<string, unknown>[] = [];
      const paths: string[] = [];
      const authorizations: Array<string | undefined> = [];
      const children: ChildProcess[] = [];
      const diagnostics: unknown[] = [];
      let failureMode: "normal" | "http" | "stream" | "hold" = "normal";
      let cancelled = false;
      let heldRequestReceived: (() => void) | undefined;
      let runtime: CodexAppServer | undefined;
      const endpoint = createServer(async (request, response) => {
        if (request.method === "GET") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        paths.push(request.url!);
        authorizations.push(request.headers.authorization);
        if (failureMode !== "normal") {
          if (failureMode === "http") {
            response.writeHead(401).end("PRIVATE_ENGINE_REPLY fixture-key");
            return;
          }
          const heldRequest =
            failureMode === "hold" &&
            JSON.stringify(bodies.at(-1)).includes("cancelled-request");
          if (heldRequest) heldRequestReceived?.();
          response.on("close", () => {
            if (heldRequest) cancelled = true;
          });
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (kind === "mlx-lm") {
            response.write(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }] })}\n\n`,
            );
            if (failureMode === "stream")
              response.end(
                `data: ${JSON.stringify({ error: { message: "PRIVATE_ENGINE_REPLY fixture-key" } })}\n\n`,
              );
          } else {
            response.write(
              `data: ${JSON.stringify({ type: "response.created", response: { id: "failing-response" } })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial" })}\n\n`,
            );
            if (failureMode === "stream")
              response.end(
                `data: ${JSON.stringify({ type: "response.failed", response: { error: { type: "invalid_request_error", code: "invalid_request_error", message: "PRIVATE_ENGINE_REPLY fixture-key" } } })}\n\n`,
              );
          }
          return;
        }
        const id = `response-${bodies.length}`;
        const finalItem = {
          type: "message",
          role: "assistant",
          id: `message-${bodies.length}`,
          content: [{ type: "output_text", text: "ENDPOINT_OK" }],
        };
        const tool = (
          bodies.at(-1)?.tools as Array<Record<string, unknown>> | undefined
        )
          ?.map((tool) =>
            kind === "mlx-lm"
              ? {
                  type: tool.type,
                  ...(tool.function as Record<string, unknown>),
                }
              : tool,
          )
          .find(
            (tool) =>
              tool.type === "function" &&
              ["shell_command", "exec_command"].includes(String(tool.name)),
          );
        if (bodies.length === 1 && !tool) {
          response
            .writeHead(400)
            .end("Fixture did not receive JSON function tools");
          return;
        }
        const arguments_ = JSON.stringify({
          [tool?.name === "exec_command" ? "cmd" : "command"]:
            "printf ENDPOINT_TOOL_OK",
          workdir: root,
        });
        if (kind === "mlx-lm") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const packet = (delta: unknown, finish: string | null = null) => ({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          const events =
            bodies.length === 1
              ? [
                  packet({ reasoning: "Fixture reasoning." }),
                  packet({
                    tool_calls: [
                      {
                        index: 0,
                        id: "endpoint-tool-call",
                        type: "function",
                        function: {
                          name: tool!.name,
                          arguments: arguments_.slice(0, 15),
                        },
                      },
                    ],
                  }),
                  packet({
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: arguments_.slice(15) },
                      },
                    ],
                  }),
                  packet({}, "tool_calls"),
                ]
              : [
                  packet({ content: "ENDPOINT_" }),
                  packet({ content: "OK" }),
                  packet({}, "stop"),
                ];
          for (const event of [
            ...events,
            {
              choices: [],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 3,
                total_tokens: 10,
              },
            },
          ])
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end("data: [DONE]\n\n");
          return;
        }
        const item =
          bodies.length === 1
            ? {
                type: "function_call",
                id: "function-item",
                call_id: "endpoint-tool-call",
                name: tool!.name,
                arguments: arguments_,
              }
            : finalItem;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item:
              bodies.length === 1
                ? { ...item, arguments: "" }
                : { ...item, content: [] },
          },
          ...(bodies.length === 1
            ? [
                {
                  type: "response.function_call_arguments.delta",
                  item_id: item.id,
                  output_index: 0,
                  delta: arguments_.slice(0, 15),
                },
                {
                  type: "response.function_call_arguments.delta",
                  item_id: item.id,
                  output_index: 0,
                  delta: arguments_.slice(15),
                },
                {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: 0,
                  arguments: arguments_,
                },
              ]
            : [
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  delta: "ENDPOINT_",
                },
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  delta: "OK",
                },
              ]),
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id,
              output: [item],
              usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
            },
          },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      try {
        await mkdir(home);
        await writeFile(
          path.join(home, "config.toml"),
          "features.plugins=false\n",
        );
        endpoint.listen(0, "127.0.0.1");
        await once(endpoint, "listening");
        const address = endpoint.address();
        if (!address || typeof address === "string")
          throw new Error("No fixture endpoint address");
        runtime = new CodexAppServer(
          binary!,
          path.join(root, "data"),
          home,
          await discoverCodexRuntime(binary!, path.join(root, "probe")),
          (diagnostic) => diagnostics.push(diagnostic),
          undefined,
          undefined,
          (executable, args, options) => {
            const child = spawn(executable, args, {
              cwd: root,
              env: { ...options.env, HOME: home, CODEX_HOME: home },
              stdio: "pipe",
            });
            children.push(child);
            return child;
          },
        );
        const model = {
          id: "model",
          routeId: "route",
          name: "gpt-5",
          reasoningEffort: null,
          // Manual models still execute tools with discovery absent.
          catalog:
            kind === "ollama" || kind === "llama-cpp" || kind === "mlx-lm"
              ? null
              : normalizeEndpointModel({
                  id: "gpt-5",
                  supports_tool_calling: true,
                }),
        };
        const provider = {
          id: `${kind}-instance`,
          name: kind,
          kind,
          baseUrl: `http://127.0.0.1:${address.port}/proxy/v1`,
          apiKey: kind === "llama-cpp" ? null : "fixture-key",
        };
        const result = await runtime.runAgentOperation({
          operationId: `endpoint-${kind}`,
          cwd: root,
          prompt:
            "Use the shell to print ENDPOINT_TOOL_OK, then reply ENDPOINT_OK.",
          developerInstructions: null,
          skillNames: [],
          outputSchema: {},
          mutationMode: "read-only",
          networkAccess: "none",
          permissionProfileId: null,
          timeoutMs: 30_000,
          model,
          provider,
          mcpServers: [],
        });
        expect(result.status).toBe("completed");
        expect(result.text).toContain("ENDPOINT_OK");
        expect(result.measuredUsage.inputTokens).toBeGreaterThan(0);
        expect(result.measuredUsage.outputTokens).toBeGreaterThan(0);
        expect(
          await runtime.runLabelInference({
            model,
            provider,
            instructions: "Return a short title without tools.",
            input: "Title this fixture.",
          }),
        ).toContain("ENDPOINT_OK");
        expect(bodies).toHaveLength(3);
        expect(bodies[2]?.tools ?? []).toEqual([]);
        expect(bodies.length).toBeGreaterThan(0);
        expect(JSON.stringify(bodies[0]?.tools)).not.toContain(
          '"type":"custom"',
        );
        const history =
          kind === "mlx-lm" ? bodies[1]?.messages : bodies[1]?.input;
        expect(JSON.stringify(history)).toContain("endpoint-tool-call");
        expect(JSON.stringify(history)).toContain("ENDPOINT_TOOL_OK");
        if (kind === "mlx-lm")
          expect(JSON.stringify(history)).toContain("Fixture reasoning.");
        expect(bodies[0]?.model).toBe("gpt-5");
        expect(
          paths.every(
            (value) =>
              value ===
              (kind === "mlx-lm"
                ? "/proxy/v1/chat/completions"
                : "/proxy/v1/responses"),
          ),
        ).toBe(true);
        // Native stream retries use five exponentially backed-off attempts.
        // Allow their actual failure to surface before the operation deadline.
        const probe = (operationId: string, timeoutMs = 15000) =>
          runtime!.runAgentOperation({
            operationId,
            cwd: root,
            prompt: `Reply OK for ${operationId}.`,
            developerInstructions: null,
            skillNames: [],
            outputSchema: {},
            mutationMode: "read-only",
            networkAccess: "none",
            permissionProfileId: null,
            timeoutMs,
            model,
            provider,
            mcpServers: [],
          });
        failureMode = "http";
        const rejected = await probe("http-failure").catch(
          (error: unknown) => error,
        );
        expect(rejected).toBeInstanceOf(Error);
        expect((rejected as Error).message).toContain("401");
        expect((rejected as Error).message).not.toContain(
          "PRIVATE_ENGINE_REPLY",
        );
        expect((rejected as Error).message).not.toContain("fixture-key");
        failureMode = "stream";
        const streamFailure = await probe("stream-failure").catch(
          (error: unknown) => error,
        );
        expect(streamFailure).toBeInstanceOf(Error);
        expect((streamFailure as Error).message).not.toContain(
          "PRIVATE_ENGINE_REPLY",
        );
        expect(JSON.stringify(diagnostics)).not.toContain(
          "PRIVATE_ENGINE_REPLY",
        );
        expect(JSON.stringify(diagnostics)).not.toContain("fixture-key");
        failureMode = "hold";
        cancelled = false;
        await expect(probe("cancelled-request", 3000)).rejects.toThrow(
          "timed out",
        );
        await expect.poll(() => cancelled, { timeout: 3000 }).toBe(true);
        cancelled = false;
        const received = new Promise<void>((resolve) => {
          heldRequestReceived = resolve;
        });
        const chat = runtime
          .runTurn({
            chatId: "endpoint-cancel-chat",
            clientMessageId: "cancelled-message",
            captureProtectedDiagnostics: false,
            cwd: root,
            threadId: null,
            executionProfile: "ide",
            isPrimary: true,
            model,
            provider,
            automationPaused: false,
            planMode: "default",
            policyContext: null,
            permissionProfileId: null,
            prompt: "Reply OK for cancelled-request.",
            rootKind: "git-worktree",
            skillNames: [],
            mcpServers: [],
            subagentDefaults: null,
            subagentProtocolVersion: undefined,
            worktreeMode: "agent-managed",
            worktreePolicy: "required-for-writes",
          })
          .catch((error: unknown) => error);
        await Promise.race([
          received,
          chat.then((result) => {
            throw result instanceof Error
              ? result
              : new Error(
                  `Chat settled before backend request: ${JSON.stringify(result)}`,
                );
          }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Chat did not reach the backend")),
              5000,
            );
            timer.unref();
          }),
        ]);
        expect(
          await runtime.interruptChat("endpoint-cancel-chat", null),
        ).toEqual({ interrupted: true });
        expect(await chat).toBeInstanceOf(CodexTurnFailureError);
        expect(await chat).toMatchObject({ terminalStatus: "interrupted" });
        await expect.poll(() => cancelled, { timeout: 3000 }).toBe(true);
        expect(
          authorizations.every((value) =>
            kind === "llama-cpp"
              ? value === undefined
              : value === "Bearer fixture-key",
          ),
        ).toBe(true);
      } finally {
        runtime?.close();
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        endpoint.closeAllConnections();
        await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
