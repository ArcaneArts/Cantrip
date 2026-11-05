import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import {
  openCodexWebSocket,
  readCodexProcessEndpoint,
} from "../src/codex/process-transport.js";
import { CodexRpcRequests } from "../src/codex/rpc-requests.js";
import { parseCodexRpcMessage } from "../src/codex/rpc-protocol.js";
import { killNativeTree } from "./native-process-tree-fixture.js";

const require = createRequire(import.meta.url);
const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

function stream(response: ServerResponse, events: Json[]) {
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

function message(id: string, text: string, phase = "final_answer") {
  return {
    type: "response.output_item.done",
    item: {
      id,
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    },
  };
}

/** Native component acceptance: actual PTYs and owners, not a product restart. */
describe.skipIf(!binary)(
  "durable suspension with a physical native TUI",
  () => {
    it.each(["paginated", "legacy"] as const)(
      "reattaches to and resumes the original TUI turn with %s history",
      async (historyMode) => {
        await verifyBuiltRuntime(path.dirname(binary!));
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-durable-tui-"),
        );
        const home = path.join(directory, "home");
        const cwd = path.join(directory, "workspace");
        const requests: { body: Json; response: ServerResponse }[] = [];
        const allRequests: Json[] = [];
        const titleRequests: Json[] = [];
        const generatedTitle = "Resume suspended TUI work";
        const server = createServer(async (request, response) => {
          let text = "";
          for await (const chunk of request) text += chunk;
          if (!request.url?.startsWith("/v1/")) {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(text) as Json;
          allRequests.push(body);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `tui-${allRequests.length}` } })}\n\n`,
          );
          const metadata = body.client_metadata?.["x-codex-turn-metadata"];
          if (
            typeof metadata === "string" &&
            JSON.parse(metadata).thread_source === "thread_title"
          ) {
            titleRequests.push(body);
            stream(response, [
              message("tui-title", JSON.stringify({ title: generatedTitle })),
              completed("tui-title-response"),
            ]);
            return;
          }
          requests.push({ body, response });
        });
        let child: ChildProcessWithoutNullStreams | undefined;
        let socket: WebSocket | undefined;
        let client: CodexRpcRequests | undefined;
        let endpoint = "";
        let frames: Json[] = [];
        const allFrames: Json[][] = [];
        const diagnostics: unknown[] = [];
        const stderr: string[] = [];
        const terminalSnapshots: string[] = [];
        let tui:
          | {
              process: import("node-pty").IPty;
              display: import("@xterm/headless").Terminal;
              exited: Promise<void>;
              alive: boolean;
            }
          | undefined;
        let succeeded = false;
        const rpc = (method: string, params: Json): Promise<Json> =>
          client!.request(method, params, 30000) as Promise<Json>;
        const terminalText = () => {
          const buffer = tui?.display.buffer.active;
          return buffer
            ? Array.from(
                { length: buffer.length },
                (_, row) => buffer.getLine(row)?.translateToString(true) ?? "",
              ).join("\n")
            : "";
        };
        const startOwner = async () => {
          child = spawn(
            binary!,
            ["app-server", "--listen", "ws://127.0.0.1:0"],
            {
              cwd,
              env: {
                PATH: process.env.PATH,
                HOME: home,
                CODEX_HOME: home,
                OPENAI_API_KEY: "fixture-only",
              },
              stdio: "pipe",
            },
          );
          child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
          endpoint = await readCodexProcessEndpoint(child, {
            runtimeId: "durable-tui-fixture",
            readableError: (line) => line,
          });
          const ownSocket = (socket = await openCodexWebSocket(endpoint));
          frames = [];
          allFrames.push(frames);
          const ownFrames = frames;
          const ownClient = (client = new CodexRpcRequests({
            send: (frame) => ownSocket.send(JSON.stringify(frame)),
            runtimeId: () => "durable-tui-fixture",
            secrets: () => new Set(),
            isZai: () => false,
            recordDiagnostic: (diagnostic) => {
              diagnostics.push(diagnostic);
              return String(diagnostics.length);
            },
          }));
          ownSocket.on("message", (data) => {
            const frame = parseCodexRpcMessage(String(data));
            if (!frame) {
              diagnostics.push({ invalidNativeFrame: String(data) });
              return;
            }
            ownFrames.push(frame);
            ownClient.handleResponse(frame, frame);
          });
          ownSocket.on("close", () =>
            ownClient.rejectAll(new Error("native owner disconnected")),
          );
          await rpc("initialize", {
            clientInfo: { name: "cantrip_durable_tui_fixture", version: "1" },
            capabilities: { experimentalApi: true },
          });
          ownSocket.send(JSON.stringify({ method: "initialized" }));
        };
        const openTui = async (threadId: string) => {
          const pty = require("node-pty") as typeof import("node-pty");
          const { Terminal } =
            require("@xterm/headless") as typeof import("@xterm/headless");
          const display = new Terminal({
            cols: 130,
            rows: 45,
            scrollback: 10000,
            allowProposedApi: true,
          });
          const terminalProcess = pty.spawn(
            binary!,
            ["--remote", endpoint, "resume", threadId],
            {
              cwd,
              cols: 130,
              rows: 45,
              name: "xterm-256color",
              env: {
                ...process.env,
                HOME: home,
                CODEX_HOME: home,
                OPENAI_API_KEY: "fixture-only",
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
                CANTRIP_CODEX_ATTACH_THREAD_ID: threadId,
              },
            },
          );
          let resolveExit!: () => void;
          const ownTui = {
            process: terminalProcess,
            display,
            alive: true,
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
          };
          terminalProcess.onExit(() => {
            ownTui.alive = false;
            resolveExit();
          });
          tui = ownTui;
          terminalProcess.onData((data) => {
            display.write(data);
            try {
              if (data.includes("\x1b[6n")) terminalProcess.write("\x1b[1;1R");
              if (data.includes("\x1b[c")) terminalProcess.write("\x1b[?1;2c");
              if (data.includes("\x1b]10;?"))
                terminalProcess.write("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
              if (data.includes("\x1b]11;?"))
                terminalProcess.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
            } catch {
              // A final capability query can arrive while the PTY is closing.
            }
          });
          await vi.waitFor(
            () => expect(terminalText()).toContain("OpenAI Codex"),
            {
              timeout: 15000,
            },
          );
        };
        const closeTui = async () => {
          if (!tui) return;
          const current = tui;
          terminalSnapshots.push(terminalText());
          if (current.alive) current.process.kill("SIGKILL");
          await current.exited;
          current.display.dispose();
          tui = undefined;
        };
        const killOwner = async () => {
          if (child) await killNativeTree(child);
          socket?.terminate();
          client?.rejectAll(new Error("native fixture owner terminated"));
          child = undefined;
          socket = undefined;
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
              'cli_auth_credentials_store="file"',
              'model_reasoning_effort="low"',
              'model_reasoning_summary="concise"',
              "features.plugins=false",
              "features.code_mode_host=false",
              "[model_providers.fixture]",
              'name="durable-tui-fixture"',
              `base_url="http://127.0.0.1:${(server.address() as { port: number }).port}/v1"`,
              'wire_api="responses"',
              "requires_openai_auth=false",
              "request_max_retries=0",
              "stream_max_retries=0",
            ].join("\n"),
          );
          await startOwner();
          const { thread } = await rpc("thread/start", { cwd, historyMode });
          const threadId = thread.id;
          await openTui(threadId);
          expect(allRequests).toHaveLength(0);
          tui!.process.write("ORIGINAL_DURABLE_TUI_INPUT");
          await vi.waitFor(
            () =>
              expect(terminalText()).toContain("ORIGINAL_DURABLE_TUI_INPUT"),
            { timeout: 5000 },
          );
          tui!.process.write("\r");
          await vi.waitFor(() => expect(requests).toHaveLength(1), {
            timeout: 15000,
          });
          // Complete the TUI's actual independent title request before capture.
          // Cold attachment below must not launch even another helper request.
          await vi.waitFor(
            () => {
              expect(titleRequests).toHaveLength(1);
              expect(
                frames.some(
                  (frame) =>
                    frame.method === "thread/name/updated" &&
                    frame.params.threadId === threadId &&
                    frame.params.threadName === generatedTitle,
                ),
              ).toBe(true);
            },
            { timeout: 15000 },
          );
          expect(
            titleRequests[0]!.text.format.schema.properties.title.type,
          ).toBe("string");
          expect(titleRequests[0]!.client_metadata.thread_id).not.toBe(
            threadId,
          );
          const started = frames.filter(
            (frame) => frame.method === "turn/started",
          );
          expect(started).toHaveLength(1);
          expect(started[0]!.params.threadId).toBe(threadId);
          const turnId = started[0]!.params.turn.id;
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
          stream(requests[0]!.response, [
            message("before-cold", "BEFORE_COLD_TUI_BOUNDARY", "commentary"),
            {
              type: "response.output_item.done",
              item: {
                id: "tui-tool-item",
                type: "function_call",
                call_id: "tui-completed-side-effect",
                name: command.name,
                ...(command.namespace ? { namespace: command.namespace } : {}),
                arguments: JSON.stringify({
                  cmd:
                    process.platform === "win32"
                      ? "Add-Content -Path durable-tui-counter.txt -Value 'done'"
                      : "printf 'done\\n' >> durable-tui-counter.txt",
                  yield_time_ms: 10000,
                }),
              },
            },
            completed("tool-response"),
          ]);
          await vi.waitFor(() => expect(requests).toHaveLength(2), {
            timeout: 15000,
          });
          const beforeCapture = await rpc("thread/read", {
            threadId,
            includeTurns: true,
          });
          const publicItemsBeforeCapture = (
            beforeCapture.thread.turns[0].items as Json[]
          ).map(({ id, type }) => ({ id, type }));
          const completedCommandFrames = () =>
            allFrames
              .flat()
              .filter(
                (frame) =>
                  frame.method === "item/completed" &&
                  frame.params.item.type === "commandExecution",
              );
          expect(completedCommandFrames()).toHaveLength(1);
          const pausing = rpc("turn/suspension", {
            threadId,
            operation: { type: "pause", turnId },
          });
          await rpc("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text: "STEERED_DURABLE_TUI_INPUT" }],
          });
          // Steering may cancel this held inference. The completed command and
          // visible commentary above already belong to the committed history.
          stream(requests[1]!.response, [completed("before-cold-response")]);
          const paused = await pausing;
          expect(paused).toMatchObject({
            paused: true,
            suspension: { threadId, turnId },
          });
          const trafficAtPause = allRequests.length;
          // No grace delay or history read between durable confirmation and death.
          await Promise.all([closeTui(), killOwner()]);
          expect(
            await readFile(path.join(cwd, "durable-tui-counter.txt"), "utf8"),
          ).toMatch(/^done\r?\n$/);
          await startOwner();
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
          await openTui(threadId);
          await vi.waitFor(
            () => expect(terminalText()).toContain("BEFORE_COLD_TUI_BOUNDARY"),
            { timeout: 15000 },
          );
          expect(terminalText()).not.toContain("Conversation interrupted");
          const coldHistory = await rpc("thread/read", {
            threadId,
            includeTurns: true,
          });
          expect(coldHistory.thread.status.type).toBe("idle");
          expect(coldHistory.thread.turns[0]).toMatchObject({
            id: turnId,
            status: "inProgress",
          });
          expect(requests).toHaveLength(2);
          expect(allRequests).toHaveLength(trafficAtPause);
          expect(
            frames.filter((frame) => frame.method === "turn/started"),
          ).toHaveLength(0);
          expect(
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "read" },
            }),
          ).toMatchObject(paused);
          await rpc("turn/pause", { threadId, turnId, paused: false });
          await vi.waitFor(() => expect(requests).toHaveLength(3), {
            timeout: 15000,
          });
          const restored = requests[2]!.body;
          expect(restored.model).toBe(requests[0]!.body.model);
          expect(restored.reasoning).toEqual(requests[0]!.body.reasoning);
          expect(
            JSON.stringify(restored.input).split("ORIGINAL_DURABLE_TUI_INPUT")
              .length - 1,
          ).toBe(1);
          expect(
            JSON.stringify(restored.input).split("STEERED_DURABLE_TUI_INPUT")
              .length - 1,
          ).toBe(1);
          expect(
            restored.input.filter(
              (item: Json) =>
                item.type === "function_call_output" &&
                item.call_id === "tui-completed-side-effect",
            ),
          ).toHaveLength(1);
          expect(
            await readFile(path.join(cwd, "durable-tui-counter.txt"), "utf8"),
          ).toMatch(/^done\r?\n$/);
          stream(requests[2]!.response, [
            message("after-cold", "AFTER_COLD_TUI_RESUME"),
            completed("after-cold-response"),
          ]);
          await vi.waitFor(
            () => {
              expect(terminalText()).toContain("AFTER_COLD_TUI_RESUME");
              expect(
                frames.find(
                  (frame) =>
                    frame.method === "turn/completed" &&
                    frame.params.turn.id === turnId,
                )?.params.turn.status,
              ).toBe("completed");
            },
            { timeout: 15000 },
          );
          expect(tui!.alive).toBe(true);
          expect(titleRequests).toHaveLength(1);
          expect(
            allFrames
              .flat()
              .filter(
                (frame) =>
                  frame.method === "turn/started" &&
                  frame.params.turn.id === turnId,
              ),
          ).toHaveLength(1);
          const history = await rpc("thread/read", {
            threadId,
            includeTurns: true,
          });
          expect(history.thread.turns).toHaveLength(1);
          expect(history.thread.turns[0]).toMatchObject({
            id: turnId,
            status: "completed",
          });
          const items = history.thread.turns[0].items as Json[];
          expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
          expect(items.map(({ id, type }) => ({ id, type }))).toEqual(
            expect.arrayContaining(publicItemsBeforeCapture),
          );
          expect(
            items.filter((item) => item.type === "commandExecution"),
          ).toHaveLength(
            publicItemsBeforeCapture.filter(
              (item) => item.type === "commandExecution",
            ).length,
          );
          expect(completedCommandFrames()).toHaveLength(1);
          expect(
            (
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              })
            ).suspension,
          ).toBeNull();
          succeeded = true;
        } finally {
          const finalTerminal = terminalText();
          await closeTui();
          await killOwner();
          requests.forEach(({ response }) => response.destroy());
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          if (succeeded) await rm(directory, { recursive: true, force: true });
          else {
            await writeFile(
              path.join(directory, "diagnostics.json"),
              JSON.stringify(
                {
                  terminal: finalTerminal,
                  terminalSnapshots,
                  frames: allFrames,
                  stderr,
                  diagnostics,
                  requests: allRequests,
                },
                null,
                2,
              ),
            );
            console.error(`Retained failed durable TUI fixture: ${directory}`);
          }
        }
      },
      120000,
    );
  },
);
