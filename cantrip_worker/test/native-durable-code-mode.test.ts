import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { handleNativeResourceProtection } from "../src/codex/native-resource-control.js";
import { killNativeTree } from "./native-process-tree-fixture.js";
import { resourceProtectionFixture } from "./native-resource-protection-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

describe.skipIf(!binary)("native durable CodeMode stored values", () => {
  it.each([
    ["paginated", "grpc"],
    ["legacy", "grpc"],
    ["paginated", "framed"],
    ["legacy", "framed"],
  ] as const)(
    "preserves %s history with the %s CodeMode transport",
    async (historyMode, transport) => {
      await verifyBuiltRuntime(path.dirname(binary!));
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-durable-code-mode-"),
      );
      const home = path.join(directory, "home"),
        cwd = path.join(directory, "workspace");
      const requests: { body: Json; response: ServerResponse }[] = [];
      const frames: Json[] = [],
        stderr: string[] = [],
        errors: unknown[] = [];
      const protections: { seal: boolean }[] = [];
      let child: ChildProcessWithoutNullStreams | undefined,
        client: CodexRpcClient | undefined;
      let generation = "",
        succeeded = false;
      let encryption: Awaited<ReturnType<typeof resourceProtectionFixture>>;
      const managedConfig = {
        mcpServers: {},
        developerInstructions: null,
        multiAgentEnabled: false,
        subagentModel: null,
        subagentReasoningEffort: null,
      };
      const provider = createServer(async (request, response) => {
        let text = "";
        for await (const chunk of request) text += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        requests.push({ body: JSON.parse(text), response });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `code-mode-${requests.length}` } })}\n\n`,
        );
      });
      const rpc = async (method: string, params: Json): Promise<Json> => {
        const result = await client!.request(method, params);
        if (result.error)
          throw new Error(`${method}: ${JSON.stringify(result.error)}`);
        return result.result as Json;
      };
      const start = async () => {
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
        const ownClient = client,
          ownGeneration = generation,
          ownProtection = encryption.protection;
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          const frame = JSON.parse(line) as Json;
          if (frame.method === "thread/nativeResources/requested") {
            protections.push({ seal: frame.params.seal });
            void handleNativeResourceProtection(frame.params, {
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
                if (result.error) throw new Error(JSON.stringify(result.error));
              },
            }).catch((error) => errors.push(error));
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
                if (result.error) throw new Error(JSON.stringify(result.error));
              })
              .catch((error) => errors.push(error));
          }
        });
        await rpc("initialize", {
          clientInfo: {
            name: "cantrip_durable_code_mode_fixture",
            version: "1",
          },
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
      const codeModeDescendants = async () => {
        if (process.platform === "win32") return [];
        const { stdout } = await promisify(execFile)("ps", [
          "-axo",
          "pid=,ppid=,command=",
        ]);
        const rows = stdout.split("\n").flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                  command: match[3]!,
                },
              ]
            : [];
        });
        const owned = new Set([child!.pid!]);
        for (;;) {
          const before = owned.size;
          for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
          if (before === owned.size) break;
        }
        return rows
          .filter(
            (row) =>
              owned.has(row.pid) && /codex-code-mode-host/.test(row.command),
          )
          .map((row) => row.pid);
      };
      const sendCell = (index: number, id: string, source: string) => {
        const body = requests[index]!.body;
        const tools =
          body.tools ??
          body.input
            .filter((item: Json) => item.type === "additional_tools")
            .flatMap((item: Json) => item.tools);
        const advertised = tools.flatMap((tool: Json) =>
          tool.type === "namespace"
            ? tool.tools.map((entry: Json) => ({
                ...entry,
                namespace: tool.name,
              }))
            : [tool],
        );
        const selected = advertised.find((tool: Json) => tool.name === "exec");
        expect(selected, "real CodeMode exec must be advertised").toBeDefined();
        expect(selected.type).toBe("custom");
        const events = [
          {
            type: "response.output_item.done",
            item: {
              type: "custom_tool_call",
              id: `item-${id}`,
              call_id: id,
              name: selected.name,
              ...(selected.namespace ? { namespace: selected.namespace } : {}),
              input: source,
            },
          },
          {
            type: "response.completed",
            response: {
              id: `response-${id}`,
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ];
        for (const event of events)
          requests[index]!.response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        requests[index]!.response.end();
      };
      const waitRequests = (count: number) =>
        vi.waitFor(() => expect(requests).toHaveLength(count), {
          timeout: 15000,
        });
      try {
        await Promise.all([mkdir(home), mkdir(cwd)]);
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        const catalog = JSON.parse(
          await readFile(
            new URL(
              "../../cantrip_codex/upstream/codex-rs/models-manager/models.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const model = {
          ...catalog.models[0],
          slug: "durable-code-mode-fixture",
          tool_mode: "code_mode_only",
        };
        await writeFile(
          path.join(home, "models.json"),
          JSON.stringify({ models: [model] }),
        );
        await writeFile(
          path.join(home, "config.toml"),
          [
            'model="durable-code-mode-fixture"',
            'model_provider="fixture"',
            'approval_policy="never"',
            'sandbox_mode="danger-full-access"',
            'model_reasoning_effort="low"',
            `model_catalog_json=${JSON.stringify(path.join(home, "models.json"))}`,
            "features.goals=false",
            "features.plugins=false",
            "features.code_mode_host=true",
            `features.code_mode_host_grpc=${transport === "grpc"}`,
            "[model_providers.fixture]",
            'name="CodeMode fixture"',
            `base_url="http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            "request_max_retries=0",
            "stream_max_retries=0",
          ].join("\n"),
        );
        await start();
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
          input: [{ type: "text", text: "ORIGINAL_CODE_MODE_INPUT" }],
        });
        const turnId = turn.id;
        await waitRequests(1);
        const pause = rpc("turn/suspension", {
          threadId,
          operation: { type: "pause", turnId },
        });
        void pause.catch(() => {});
        sendCell(
          0,
          "store-once",
          `await tools.exec_command({cmd:${JSON.stringify(process.platform === "win32" ? "Add-Content -Path code-mode-effect.txt -Value once" : "echo once >> code-mode-effect.txt")},yield_time_ms:10000}); store("private", {marker:["INERT","CODE","MODE","SECRET"].join("_"), nested:[null,true,2.5], count:1}); text("SAVED_ONCE");`,
        );
        if (transport === "framed") {
          await expect(pause).rejects.toThrow(
            "does not support durable stored state",
          );
          expect(requests).toHaveLength(1);
          expect(protections).toEqual([]);
          await rpc("turn/pause", { threadId, turnId, paused: false });
          await waitRequests(2);
          expect(JSON.stringify(requests[1]!.body.input)).toContain(
            "SAVED_ONCE",
          );
          await rpc("turn/interrupt", { threadId, turnId });
          expect(
            (
              await readFile(path.join(cwd, "code-mode-effect.txt"), "utf8")
            ).trim(),
          ).toBe("once");
          expect(errors).toEqual([]);
          succeeded = true;
          return;
        }
        let paused = await pause;
        expect(paused).toMatchObject({
          paused: true,
          suspension: { threadId, turnId },
        });
        const checkpointFile = path.join(
          home,
          "turn-suspensions",
          `${createHash("sha256").update(threadId).digest("hex")}.json`,
        );
        expect(await readFile(checkpointFile, "utf8")).not.toContain(
          "INERT_CODE_MODE_SECRET",
        );
        expect(protections).toEqual([{ seal: true }]);
        expect(requests).toHaveLength(1);
        for (let cycle = 0; cycle < 2; cycle++) {
          // Hard-kill every native descendant immediately after the durable ACK.
          await kill();
          await start();
          expect(
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "read" },
            }),
          ).toMatchObject(paused);
          const opens = protections.filter((request) => !request.seal).length;
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
          expect(protections.filter((request) => !request.seal)).toHaveLength(
            opens,
          );
          if (process.platform !== "win32")
            expect(await codeModeDescendants()).toEqual([]);
          expect(requests).toHaveLength(1 + cycle);
          if (cycle === 0) {
            await encryption.authorize(false);
            await expect(
              rpc("turn/pause", { threadId, turnId, paused: false }),
            ).rejects.toThrow("chat-content encryption grant");
            expect(
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              }),
            ).toMatchObject(paused);
            expect(requests).toHaveLength(1);
            await encryption.authorize(true);
          }
          const resume = () =>
            rpc("turn/pause", { threadId, turnId, paused: false });
          await Promise.all([resume(), resume()]);
          await waitRequests(2 + cycle);
          const request = requests[1 + cycle]!.body;
          expect(request.model).toBe(requests[0]!.body.model);
          expect(request.reasoning).toEqual(requests[0]!.body.reasoning);
          expect(
            JSON.stringify(request.input).split("ORIGINAL_CODE_MODE_INPUT")
              .length - 1,
          ).toBe(1);
          expect(
            request.input.filter(
              (item: Json) =>
                item.type === "custom_tool_call_output" &&
                item.call_id === "store-once",
            ),
          ).toHaveLength(1);
          const again = rpc("turn/suspension", {
            threadId,
            operation: { type: "pause", turnId },
          });
          void again.catch(() => {});
          sendCell(
            1 + cycle,
            `read-${cycle}`,
            `const value=load("private"); text(JSON.stringify(value)); value.count++; store("private",value);`,
          );
          const next = await again;
          expect(next.suspension.checkpointId).not.toBe(
            paused.suspension.checkpointId,
          );
          paused = next;
          expect(requests).toHaveLength(2 + cycle);
        }
        // Keep the checkpoint owner alive but kill its real CodeMode helper.
        // Explicit live Resume must import the saved data into a replacement host.
        if (process.platform !== "win32") {
          const helpers = await codeModeDescendants();
          expect(helpers).toHaveLength(1);
          for (const pid of helpers) process.kill(pid, "SIGKILL");
          await vi.waitFor(
            async () => expect(await codeModeDescendants()).toEqual([]),
            { timeout: 15000 },
          );
        }
        await rpc("turn/pause", { threadId, turnId, paused: false });
        await waitRequests(4);
        for (let cycle = 0; cycle < 2; cycle++) {
          const output = requests[cycle + 2]!.body.input.find(
            (item: Json) =>
              item.type === "custom_tool_call_output" &&
              item.call_id === `read-${cycle}`,
          );
          expect(JSON.stringify(output)).toContain("INERT_CODE_MODE_SECRET");
          expect(JSON.stringify(output).replaceAll("\\", "")).toContain(
            `"count":${cycle + 1}`,
          );
        }
        expect(
          (await readFile(path.join(cwd, "code-mode-effect.txt"), "utf8"))
            .trim()
            .split(/\r?\n/),
        ).toEqual(["once"]);
        await rpc("turn/interrupt", { threadId, turnId });
        await vi.waitFor(
          () =>
            expect(
              frames.filter(
                (frame) =>
                  frame.method === "turn/completed" &&
                  frame.params.turn.id === turnId,
              ),
            ).toHaveLength(1),
          { timeout: 15000 },
        );
        expect(
          frames.filter((frame) => frame.method === "turn/started"),
        ).toHaveLength(1);
        expect(
          await rpc("turn/suspension", {
            threadId,
            operation: { type: "read" },
          }),
        ).toMatchObject({ paused: false, suspension: null });
        expect(errors).toEqual([]);
        succeeded = true;
      } finally {
        if (!succeeded)
          await writeFile(
            path.join(directory, "diagnostics.json"),
            JSON.stringify(
              {
                frames,
                stderr,
                errors: errors.map(String),
                requests: requests.map((request) => request.body),
              },
              null,
              2,
            ),
          );
        await kill();
        for (const request of requests) request.response.destroy();
        provider.closeAllConnections();
        if (provider.listening)
          await new Promise<void>((resolve) => provider.close(() => resolve()));
        if (succeeded) await rm(directory, { recursive: true, force: true });
      }
    },
    90000,
  );
});
