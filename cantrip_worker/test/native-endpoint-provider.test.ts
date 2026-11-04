import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeEndpointProviderKinds } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { normalizeEndpointModel } from "../src/endpoint-models.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

// Uses the actual pinned executable and Cantrip's production provider/operation
// configuration against a synthetic HTTP endpoint. This is not a real-backend benchmark.
describe.skipIf(!binary)("native endpoint provider connections", () => {
  it.each(nativeEndpointProviderKinds)(
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
        const id = `response-${bodies.length}`;
        const finalItem = {
          type: "message",
          role: "assistant",
          id: `message-${bodies.length}`,
          content: [{ type: "output_text", text: "ENDPOINT_OK" }],
        };
        const tool = (
          bodies.at(-1)?.tools as Array<Record<string, unknown>> | undefined
        )?.find(
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
          undefined,
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
          model: {
            id: "model",
            routeId: "route",
            name: "gpt-5",
            reasoningEffort: null,
            // A manual model must still execute tools when discovery is absent.
            catalog:
              kind === "llama-cpp"
                ? null
                : normalizeEndpointModel({
                    id: "gpt-5",
                    supports_tool_calling: true,
                  }),
          },
          provider: {
            id: `${kind}-instance`,
            name: kind,
            kind,
            baseUrl: `http://127.0.0.1:${address.port}/proxy/v1`,
            apiKey: kind === "llama-cpp" ? null : "fixture-key",
          },
          mcpServers: [],
        });
        expect(result.status).toBe("completed");
        expect(result.text).toContain("ENDPOINT_OK");
        expect(bodies.length).toBeGreaterThan(0);
        expect(JSON.stringify(bodies[0]?.tools)).not.toContain(
          '"type":"custom"',
        );
        expect(JSON.stringify(bodies[1]?.input)).toContain(
          "endpoint-tool-call",
        );
        expect(JSON.stringify(bodies[1]?.input)).toContain("ENDPOINT_TOOL_OK");
        expect(bodies[0]?.model).toBe("gpt-5");
        expect(paths.every((value) => value === "/proxy/v1/responses")).toBe(
          true,
        );
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
    60_000,
  );
});
