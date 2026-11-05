import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { killNativeTree } from "./native-process-tree-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

// Real stdio MCP processes report their actual initialize/list/call operations.
// The tool's reply waits on an explicit HTTP release, never a timer or sleep.
const mcpSource = `
const fs = require('node:fs');
const readline = require('node:readline');
const [endpoint, name, failureFile] = process.argv.slice(2);
async function event(type) {
  const result = await fetch(endpoint, { method:'POST', body:JSON.stringify({name,type,pid:process.pid}) });
  if (!result.ok) throw new Error('fixture event rejected');
}
const started = event('start');
const lines = readline.createInterface({input:process.stdin});
let serial = started;
lines.on('line', line => { serial = serial.then(async () => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  let result = {};
  if (request.method === 'initialize') {
    await event('initialize');
    if (fs.existsSync(failureFile) && fs.readFileSync(failureFile,'utf8') === 'block') {
      await fetch(endpoint.replace('/event','/initialize'));
    } else if (fs.existsSync(failureFile)) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'ACTUAL_MCP_INITIALIZE_FAILURE'}})+'\\n');
      return;
    }
    result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name,version:'1'}};
  } else if (request.method === 'tools/list') {
    await event('list');
    result = {tools:[{name:'count',description:'Perform one counted fixture operation',inputSchema:{type:'object',properties:{}}}]};
  } else if (request.method === 'tools/call') {
    await event('tool');
    await fetch(endpoint.replace('/event','/release'));
    result = {content:[{type:'text',text:'COMPLETED_MCP_OPERATION_'+name}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}); });
lines.on('close', () => { process.exit(0); });
`;

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

describe.skipIf(!binary)("durable suspension with real MCP sessions", () => {
  it.each(["live", "cold", "failure", "stop", "blocked", "repaused"] as const)(
    "%s keeps completed operations and starts MCP only on explicit Resume",
    async (mode) => {
      await verifyBuiltRuntime(path.dirname(binary!));
      const root = await mkdtemp(path.join(tmpdir(), "cantrip-durable-mcp-"));
      const home = path.join(root, "home"),
        cwd = path.join(root, "workspace");
      const failureFile = path.join(root, "fail-initialize");
      const script = path.join(root, "mcp.cjs");
      const requests: { body: Json; response: ServerResponse }[] = [];
      const events: Json[] = [],
        frames: Json[] = [],
        errors: unknown[] = [];
      const changed = new EventEmitter();
      const until = async (predicate: () => boolean) => {
        while (!predicate()) await once(changed, "change");
      };
      const releases: ServerResponse[] = [];
      const initializing: ServerResponse[] = [];
      const provider = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        if (request.url === "/event") {
          events.push(JSON.parse(body));
          response.end("ok");
          changed.emit("change");
        } else if (request.url === "/initialize") {
          initializing.push(response);
          changed.emit("change");
        } else if (request.url === "/release") {
          releases.push(response);
          changed.emit("change");
        } else if (request.url?.startsWith("/v1/")) {
          requests.push({ body: JSON.parse(body), response });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `mcp-${requests.length}` } })}\n\n`,
          );
          changed.emit("change");
        } else response.writeHead(404).end();
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let client: CodexRpcClient | undefined;
      let succeeded = false;
      const stderr: string[] = [];
      const rpc = async (method: string, params: Json): Promise<Json> => {
        const result = await client!.request(method, params);
        if (result.error)
          throw new Error(`${method}: ${JSON.stringify(result.error)}`);
        return result.result as Json;
      };
      const start = async () => {
        child = spawn(binary!, ["app-server"], {
          cwd,
          stdio: "pipe",
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        });
        child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
        const ownClient = (client = new CodexRpcClient(child, 30000));
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          const frame = JSON.parse(line) as Json;
          frames.push(frame);
          changed.emit("change");
          if (
            frame.method === "thread/managedExecution/requested" &&
            frame.params.trigger === "inference"
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
          clientInfo: { name: "cantrip_durable_mcp", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
      };
      const kill = async () => {
        if (child) await killNativeTree(child);
        client?.close();
        client = undefined;
        child = undefined;
      };
      onTestFinished(async () => {
        await kill();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      });
      try {
        await Promise.all([
          mkdir(home),
          mkdir(cwd),
          writeFile(script, mcpSource),
        ]);
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
        const registration = (name: string) =>
          [
            `[mcp_servers.${name}]`,
            `command=${JSON.stringify(process.execPath)}`,
            `args=${JSON.stringify([script, `${endpoint}/event`, name, failureFile])}`,
            "required=true",
            "startup_timeout_sec=10",
            "",
          ].join("\n");
        const hookFile = path.join(root, "session-start.cjs");
        await writeFile(
          hookFile,
          `const fs=require('node:fs'); fs.readFileSync(0,'utf8'); fetch(${JSON.stringify(`${endpoint}/event`)},{method:'POST',body:JSON.stringify({name:'hook',type:'session-start'})}).then(()=>process.stdout.write('{}'));`,
        );
        await writeFile(
          path.join(home, "hooks.json"),
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookFile)}`,
                    },
                  ],
                },
              ],
            },
          }),
        );
        const config = [
          'model="gpt-5"',
          'model_provider="fixture"',
          'approval_policy="never"',
          'sandbox_mode="danger-full-access"',
          "features.plugins=false",
          "features.code_mode_host=false",
          "[model_providers.fixture]",
          'name="Fixture"',
          `base_url="${endpoint}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "request_max_retries=0",
          "stream_max_retries=0",
          "",
          registration("original"),
        ].join("\n");
        await writeFile(path.join(home, "config.toml"), config);
        await start();
        const catalog = await rpc("hooks/list", { cwds: [cwd] });
        const hooks = catalog.data.flatMap((entry: Json) => entry.hooks);
        expect(hooks).toHaveLength(1);
        await rpc("config/value/write", {
          keyPath: "hooks.state",
          value: Object.fromEntries(
            hooks.map((hook: Json) => [
              hook.key,
              { trusted_hash: hook.currentHash },
            ]),
          ),
          mergeStrategy: "upsert",
        });
        const { thread } = await rpc("thread/start", {
          cwd,
          historyMode: "paginated",
        });
        const threadId = thread.id;
        const first = await rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: "ORIGINAL_MCP_REQUEST" }],
        });
        const turnId = first.turn.id;
        await until(() => requests.length === 1);
        const tools = requests[0]!.body.tools.flatMap((entry: Json) =>
          entry.type === "namespace"
            ? entry.tools.map((tool: Json) => ({
                ...tool,
                namespace: entry.name,
              }))
            : [entry],
        );
        const selected = tools.find((tool: Json) => /count$/.test(tool.name));
        expect(selected, "the real MCP tool must be advertised").toBeDefined();
        stream(requests[0]!.response, [
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "mcp-item",
              call_id: "mcp-operation",
              name: selected.name,
              ...(selected.namespace ? { namespace: selected.namespace } : {}),
              arguments: "{}",
            },
          },
          completed("mcp-tool-response"),
        ]);
        await until(() => releases.length === 1);
        const pausing = rpc("turn/suspension", {
          threadId,
          operation: { type: "pause", turnId },
        });
        void pausing.catch(() => undefined);
        await rpc("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "ACCEPTED_MCP_STEER" }],
        });
        releases[0]!.end("released");
        const { suspension } = await pausing;
        expect(suspension).toMatchObject({ threadId, turnId });
        expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
        expect(requests).toHaveLength(1);
        expect(
          events.filter((event) => event.type === "session-start"),
        ).toHaveLength(1);
        const pausedEvents = events.length;
        if (mode !== "live") {
          await kill();
          // This required server has never started and has no cached catalog.
          await writeFile(
            path.join(home, "config.toml"),
            config + registration("uncached"),
          );
          await writeFile(
            failureFile,
            mode === "blocked" || mode === "repaused"
              ? "block"
              : "actual MCP initialization must fail if attempted",
          );
          await start();
          await rpc("thread/resume", {
            threadId,
            expectedSuspension: suspension,
          });
          expect(
            (
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              })
            ).suspension,
          ).toEqual(suspension);
          await rpc("thread/read", { threadId, includeTurns: true });
          expect(events).toHaveLength(pausedEvents);
          expect(requests).toHaveLength(1);
        }
        if (mode === "blocked" || mode === "repaused") {
          const resuming = rpc("turn/suspension", {
            threadId,
            operation: { type: "resume", suspension },
          });
          void resuming.catch(() => undefined);
          await until(() => initializing.length > 0);
          // The real stdio peer is still withholding initialization. Stop must
          // complete without releasing that IPC response.
          if (mode === "repaused") {
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "pause", turnId },
                })
              ).suspension,
            ).toEqual(suspension);
            // Inspect the actual processes at ACK; TCP close delivery can lag
            // behind the independent native stdout reply.
            const started = events
              .slice(pausedEvents)
              .filter((event) => event.type === "start");
            expect(started.length).toBeGreaterThan(0);
            expect(
              started.every((event) => {
                try {
                  process.kill(event.pid, 0);
                  return false;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ESRCH")
                    return true;
                  throw error;
                }
              }),
            ).toBe(true);
          } else {
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "discard", turnId },
            });
          }
          expect(
            initializing.every((response) => !response.writableEnded),
          ).toBe(true);
          await expect(resuming).rejects.toThrow();
          expect(requests).toHaveLength(1);
          expect(
            (
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              })
            ).suspension,
          ).toEqual(mode === "repaused" ? suspension : null);
        } else if (mode === "stop") {
          await rpc("turn/suspension", {
            threadId,
            operation: { type: "discard", turnId },
          });
          expect(events).toHaveLength(pausedEvents);
          expect(requests).toHaveLength(1);
        } else {
          if (mode === "failure") {
            await expect(
              rpc("turn/suspension", {
                threadId,
                operation: { type: "resume", suspension },
              }),
            ).rejects.toThrow(/MCP|required|ACTUAL_MCP_INITIALIZE_FAILURE/i);
            expect(events.length).toBeGreaterThan(pausedEvents);
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                })
              ).suspension,
            ).toEqual(suspension);
            expect(requests).toHaveLength(1);
          }
          await rm(failureFile, { force: true });
          await rpc("turn/suspension", {
            threadId,
            operation: { type: "resume", suspension },
          });
          await until(() => requests.length === 2);
          expect(
            events.filter((event) => event.type === "start").length,
          ).toBeGreaterThan(1);
          expect(events.filter((event) => event.type === "tool")).toHaveLength(
            1,
          );
          const input = JSON.stringify(requests[1]!.body.input);
          expect(input).toContain("COMPLETED_MCP_OPERATION_original");
          expect(input).toContain("ACCEPTED_MCP_STEER");
          expect(input.match(/ORIGINAL_MCP_REQUEST/g)).toHaveLength(1);
          stream(requests[1]!.response, [
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "finished-mcp",
                phase: "final_answer",
                content: [{ type: "output_text", text: "MCP_RESUMED" }],
              },
            },
            completed("mcp-finished"),
          ]);
          await until(() =>
            frames.some(
              (frame) =>
                frame.method === "turn/completed" &&
                frame.params.turn.id === turnId,
            ),
          );
        }
        const history = JSON.stringify(
          await rpc("thread/read", { threadId, includeTurns: true }),
        );
        expect(history).toContain(turnId);
        expect(
          frames.filter((frame) => frame.method === "turn/started"),
        ).toHaveLength(1);
        expect(errors).toEqual([]);
        succeeded = true;
      } finally {
        await kill();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        if (succeeded) await rm(root, { recursive: true, force: true });
        else
          console.error({
            root,
            events,
            frames: frames.slice(-8),
            stderr: stderr.join(""),
          });
      }
    },
    90000,
  );
});
