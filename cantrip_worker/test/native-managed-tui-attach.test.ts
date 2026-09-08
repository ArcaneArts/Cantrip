import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { TerminalManager } from "../src/terminal-manager.js";
import { describe, expect, it, vi } from "vitest";

// Opt-in native protocol regression. Both clients are real remote WebSocket
// clients of the supplied pinned app-server, including an actual isolated TUI PTY.
// No account, model turn, or desktop input is used; a fake provider rejects inference.
const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type JsonObject = Record<string, any>;

class RemoteClient {
  readonly messages: JsonObject[] = [];
  readonly pending = new Map<
    number,
    {
      resolve(message: JsonObject): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as JsonObject;
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Native fixture connection closed"));
      }
      this.pending.clear();
    });
  }

  async raw(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    const result = new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native fixture RPC timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const response = await this.raw(method, params);
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result as JsonObject;
  }

  async disconnect(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.terminate();
    await closed;
  }
}

const mcpFixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method:request.method})+'\n');
  if(request.id===undefined)return;
  const result=request.method==='initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'empty-thread-fixture',version:'1'}}
    : request.method==='tools/list'
      ? {tools:[{name:'observe_only',description:'Never invoked.',inputSchema:{type:'object',properties:{}}}]}
      : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`;

function settings(response: JsonObject) {
  return Object.fromEntries(
    [
      "model",
      "modelProvider",
      "reasoningEffort",
      "serviceTier",
      "cwd",
      "approvalPolicy",
      "approvalsReviewer",
      "sandbox",
      "activePermissionProfile",
      "runtimeWorkspaceRoots",
      "instructionSources",
    ].map((key) => [key, response[key]]),
  );
}

async function fixture(migration = false) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-managed-tui-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const mcp = path.join(root, "mcp.cjs");
  const mcpLog = path.join(root, "mcp.jsonl");
  const modelCatalog = path.join(root, "models.json");
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    providerRequests.push(request.url ?? "");
    response
      .writeHead(500)
      .end("Inference must not run during empty attachment.");
  });
  const clients: RemoteClient[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<void> | undefined;
  const readers: readline.Interface[] = [];
  const cleanup = async () => {
    for (const client of clients) await client.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child?.kill("SIGKILL"), 2_000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    for (const reader of readers) reader.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await Promise.all([
      mkdir(home),
      mkdir(workspace),
      writeFile(mcp, mcpFixture),
    ]);
    if (migration) {
      const catalog = JSON.parse(
        await readFile(
          new URL(
            "../../cantrip_codex/upstream/codex-rs/models-manager/models.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const base = catalog.models[0];
      await writeFile(
        modelCatalog,
        JSON.stringify({
          models: [
            {
              ...base,
              slug: "gpt-5",
              display_name: "Fixture old model",
              upgrade: {
                model: "fixture-upgrade",
                migration_markdown: "CANTRIP_FIXTURE_MODEL_MIGRATION",
              },
            },
            {
              ...base,
              slug: "fixture-upgrade",
              display_name: "Fixture new model",
              upgrade: null,
            },
          ],
        }),
      );
    }
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("Missing provider address");
    await writeFile(
      path.join(home, "config.toml"),
      [
        'model = "gpt-5"',
        "features.plugins = false",
        'model_provider = "empty_fixture"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        ...(migration
          ? [`model_catalog_json = ${JSON.stringify(modelCatalog)}`]
          : []),
        "[model_providers.empty_fixture]",
        'name = "Empty thread fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        ...(migration
          ? [...new Set([workspace, await realpath(workspace)])].flatMap(
              (cwd) => [
                `[projects.${JSON.stringify(cwd)}]`,
                'trust_level = "trusted"',
              ],
            )
          : []),
        "",
      ].join("\n"),
    );
    child = spawn(binary!, ["app-server", "--listen", "ws://127.0.0.1:0"], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: "pipe",
    });
    closed = new Promise<void>((resolve) =>
      child!.once("close", () => resolve()),
    );
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native fixture did not listen")),
        15_000,
      );
      child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Native fixture exited before listening"));
      });
      for (const stream of [child!.stdout, child!.stderr]) {
        const reader = readline.createInterface({ input: stream });
        readers.push(reader);
        reader.on("line", (line) => {
          const match = /^\s*listening on:\s+(ws:\/\/\S+)\s*$/.exec(
            stripVTControlCharacters(line),
          );
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
          }
        });
      }
    });
    const connect = async () => {
      const socket = new WebSocket(endpoint);
      await once(socket, "open");
      const client = new RemoteClient(socket);
      clients.push(client);
      await client.request("initialize", {
        clientInfo: { name: "cantrip_empty_thread_attach_test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return client;
    };
    return {
      cleanup,
      endpoint,
      connect,
      clients,
      workspace,
      home,
      mcp,
      mcpLog,
      providerRequests,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Transparent recording only: every RPC and notification is handled by the
// actual pinned app-server. No canned TUI/bootstrap/resume responses are used.
async function recordingProxy(endpoint: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No proxy port");
  const requests: JsonObject[] = [];
  const responses: JsonObject[] = [];
  const sockets = new Set<WebSocket>();
  server.on("connection", (client) => {
    const upstream = new WebSocket(endpoint);
    sockets.add(client);
    sockets.add(upstream);
    const queued: string[] = [];
    client.on("message", (raw) => {
      requests.push(JSON.parse(raw.toString()));
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString());
      else queued.push(raw.toString());
    });
    upstream.on("open", () => {
      for (const raw of queued) upstream.send(raw);
      queued.length = 0;
    });
    upstream.on("message", (raw) => {
      responses.push(JSON.parse(raw.toString()));
      if (client.readyState === WebSocket.OPEN) client.send(raw.toString());
    });
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
    client.on("error", () => upstream.close());
    upstream.on("error", () => client.close());
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    requests,
    responses,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(!binary || process.platform === "win32")(
  "pinned native managed TUI attachment",
  () => {
    it.each([false, true])(
      "keeps model migration interactive only for ordinary CLI (managed=%s)",
      async (managed) => {
        const f = await fixture(true);
        const proxy = await recordingProxy(f.endpoint);
        const manager = new TerminalManager({ environment: { HOME: f.home } });
        let output = "";
        try {
          const creator = await f.connect();
          const started = await creator.request("thread/start", {
            model: "gpt-5",
            modelProvider: "empty_fixture",
            cwd: f.workspace,
            approvalPolicy: "on-request",
            sandbox: "read-only",
          });
          const threadId = started.thread.id as string;
          const modelList = await creator.request("model/list", {});
          expect(
            modelList.data.find((model: JsonObject) => model.model === "gpt-5")
              ?.upgrade,
          ).toBeTruthy();
          const configBefore = await readFile(
            path.join(f.home, "config.toml"),
            "utf8",
          );
          const terminalId = "migration";
          const exited = manager.open(
            terminalId,
            "migration",
            f.workspace,
            120,
            40,
            {
              type: "codex",
              binary: binary!,
              codexHome: f.home,
              remoteUrl: proxy.endpoint,
              threadId,
              model: { id: "old", name: "gpt-5", reasoningEffort: null },
              provider: {
                id: "provider",
                name: "fixture",
                kind: "openai-compatible",
                baseUrl: "http://127.0.0.1:1/v1",
                apiKey: null,
              },
              ...(managed
                ? {
                    session: {
                      chatId: "chat",
                      contextKind: "project" as const,
                      projectId: "project",
                      worktreeId: "worktree",
                      rootKind: "git-worktree" as const,
                      scratchRootId: null,
                      computerUseEnabled: false,
                    },
                  }
                : {}),
            },
            (event) => {
              if (event.type !== "terminal.output") return;
              output += event.data;
              if (event.data.includes("\x1b[6n"))
                manager.input(terminalId, "\x1b[1;1R");
              if (event.data.includes("\x1b[c"))
                manager.input(terminalId, "\x1b[?1;2c");
              if (event.data.includes("\x1b]10;?"))
                manager.input(terminalId, "\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
              if (event.data.includes("\x1b]11;?"))
                manager.input(terminalId, "\x1b]11;rgb:0000/0000/0000\x1b\\");
            },
          );
          void exited.catch(() => {});
          if (managed) {
            await vi.waitFor(
              () => {
                const resume = proxy.requests.find(
                  (request) => request.method === "thread/resume",
                );
                expect(
                  resume,
                  stripVTControlCharacters(output).slice(-2000),
                ).toBeDefined();
                const response = proxy.responses.find(
                  (response) =>
                    response.id === resume!.id && response.result?.thread,
                );
                expect(response).toBeDefined();
                expect(settings(response!.result)).toEqual(settings(started));
              },
              { timeout: 5_000 },
            );
            expect(stripVTControlCharacters(output)).not.toContain(
              "CANTRIP_FIXTURE_MODEL_MIGRATION",
            );
          } else {
            await vi.waitFor(
              () => {
                expect(stripVTControlCharacters(output)).toContain(
                  "CANTRIP_FIXTURE_MODEL_MIGRATION",
                );
              },
              { timeout: 5_000 },
            );
            expect(
              proxy.requests.some(
                (request) => request.method === "thread/resume",
              ),
            ).toBe(false);
          }
          expect(
            proxy.requests.filter((request) =>
              /^config\/.*write/.test(request.method ?? ""),
            ),
          ).toEqual([]);
          expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(
            configBefore,
          );
          expect(f.providerRequests).toEqual([]);
          manager.close(terminalId);
          await exited;
        } finally {
          manager.closeAll();
          await proxy.close();
          await f.cleanup();
        }
      },
      20_000,
    );

    it("preserves the bound native thread through real TUI open, reopen and cold resume", async () => {
      const f = await fixture();
      const proxy = await recordingProxy(f.endpoint);
      const manager = new TerminalManager({ environment: { HOME: f.home } });
      let output = "";
      try {
        const creator = await f.connect();
        const started = await creator.request("thread/start", {
          cwd: f.workspace,
          model: "gpt-5",
          modelProvider: "empty_fixture",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          developerInstructions: "Preserve these managed instructions.",
          config: {
            model_reasoning_effort: "high",
            "mcp_servers.empty_fixture": {
              command: process.execPath,
              args: [f.mcp, f.mcpLog],
              required: true,
            },
          },
        });
        const threadId = started.thread.id as string;
        let expectedCatalog = await creator.request("mcpServerStatus/list", {
          threadId,
        });
        expect(JSON.stringify(expectedCatalog)).toContain("observe_only");
        let originalSettings = settings(started);
        const configBefore = await readFile(
          path.join(f.home, "config.toml"),
          "utf8",
        );
        for (const attachment of ["first", "reopened", "cold"]) {
          if (attachment === "cold") {
            const unload = async () => {
              // Native unsubscribe only releases observation. Archive/unarchive
              // explicitly retires the loaded engine without inventing a turn.
              await creator.request("thread/archive", { threadId });
              await creator.request("thread/unarchive", { threadId });
              await vi.waitFor(
                async () => {
                  expect(
                    (await creator.request("thread/loaded/list", {})).data,
                  ).not.toContain(threadId);
                },
                { timeout: 5_000 },
              );
            };
            await unload();
            // Establish native's durable restore result independently of TUI
            // config, then unload again so the TUI performs the real cold join.
            originalSettings = settings(
              await creator.request("thread/resume", { threadId }),
            );
            expectedCatalog = await creator.request("mcpServerStatus/list", {
              threadId,
            });
            await unload();
          }
          const requestStart = proxy.requests.length;
          const responseStart = proxy.responses.length;
          const terminalId = `managed-tui-${attachment}`;
          const exited = manager.open(
            terminalId,
            attachment,
            f.workspace,
            120,
            40,
            {
              type: "codex",
              binary: binary!,
              codexHome: f.home,
              remoteUrl: proxy.endpoint,
              threadId,
              // Deliberately conflicting GUI launch hints and local config. The
              // native session is the authority when attaching this view.
              model: {
                id: "wrong",
                name: "wrong-model",
                reasoningEffort: "low",
              },
              provider: {
                id: "wrong",
                name: "wrong",
                kind: "openai-compatible",
                baseUrl: "http://127.0.0.1:1/v1",
                apiKey: null,
              },
              session: {
                chatId: "chat",
                contextKind: "project",
                projectId: "project",
                worktreeId: "worktree",
                rootKind: "git-worktree",
                scratchRootId: null,
                computerUseEnabled: false,
              },
            },
            (event) => {
              if (event.type !== "terminal.output") return;
              output += event.data;
              // Respond only to terminal capability queries, never to product
              // prompts. These bytes stay inside this fixture's isolated PTY.
              if (event.data.includes("\x1b[6n"))
                manager.input(terminalId, "\x1b[1;1R");
              if (event.data.includes("\x1b[c"))
                manager.input(terminalId, "\x1b[?1;2c");
              if (event.data.includes("\x1b]10;?"))
                manager.input(terminalId, "\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
              if (event.data.includes("\x1b]11;?"))
                manager.input(terminalId, "\x1b]11;rgb:0000/0000/0000\x1b\\");
            },
          );
          void exited.catch(() => {});
          await vi.waitFor(
            () => {
              const resume = proxy.requests
                .slice(requestStart)
                .find((request) => request.method === "thread/resume");
              expect(
                resume,
                stripVTControlCharacters(output).slice(0, 3000),
              ).toBeDefined();
              const response = proxy.responses
                .slice(responseStart)
                .find(
                  (response) =>
                    response.id === resume!.id && response.result?.thread,
                );
              expect(response).toBeDefined();
              expect(response!.error).toBeUndefined();
            },
            { timeout: 20_000 },
          );
          const resumes = proxy.requests
            .slice(requestStart)
            .filter((request) => request.method === "thread/resume");
          expect(resumes).toHaveLength(1);
          const resume = resumes[0]!;
          // Optional nulls and history transport flags are native defaults;
          // no configuration field may carry an override.
          const effectiveParams = Object.fromEntries(
            Object.entries(resume.params).filter(
              ([, value]) => value !== null && value !== false,
            ),
          );
          expect(effectiveParams).toEqual({ threadId, excludeTurns: true });
          const resumed = proxy.responses
            .slice(responseStart)
            .find(
              (response) =>
                response.id === resume.id && response.result?.thread,
            )!.result;
          expect(resumed.thread.id).toBe(threadId);
          if (attachment !== "cold") {
            expect(resumed.thread.sessionId).toBe(started.thread.sessionId);
          }
          expect(settings(resumed)).toEqual(originalSettings);
          expect(
            settings(await creator.request("thread/resume", { threadId })),
          ).toEqual(originalSettings);
          expect(
            await creator.request("mcpServerStatus/list", { threadId }),
          ).toEqual(expectedCatalog);
          manager.close(terminalId);
          await exited;
        }
        expect(
          proxy.requests.filter((request) =>
            /^(turn\/|thread\/settings\/update|thread\/start|config\/.*write)/.test(
              request.method ?? "",
            ),
          ),
        ).toEqual([]);
        expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(
          configBefore,
        );
        expect(
          (
            await creator.request("thread/read", {
              threadId,
              includeTurns: true,
            })
          ).thread.turns,
        ).toEqual([]);
        expect(f.providerRequests).toEqual([]);
        expect(await readFile(f.mcpLog, "utf8")).not.toContain('"tools/call"');
      } finally {
        manager.closeAll();
        await proxy.close();
        await f.cleanup();
      }
    }, 60_000);
  },
);
