import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

// Opt-in native protocol regression. Both clients are real remote WebSocket
// clients of the supplied pinned app-server; no account, TUI, model turn, or
// desktop input is used. A rejecting fake provider also detects inference.
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
    this.socket.close();
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

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-empty-attach-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const mcp = path.join(root, "mcp.cjs");
  const mcpLog = path.join(root, "mcp.jsonl");
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
      await closed;
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
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("Missing provider address");
    await writeFile(
      path.join(home, "config.toml"),
      [
        'model = "gpt-5"',
        'model_provider = "empty_fixture"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "[model_providers.empty_fixture]",
        'name = "Empty thread fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
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

describe.skipIf(!binary)("pinned native empty-thread remote attach", () => {
  it.each(["legacy", "paginated"])(
    "joins an unnamed empty %s thread from two clients without inference",
    async (historyMode) => {
      const f = await fixture();
      try {
        const creator = await f.connect();
        const peer = await f.connect();
        const started = await creator.request("thread/start", {
          historyMode,
          cwd: f.workspace,
          model: "gpt-5",
          modelProvider: "empty_fixture",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          developerInstructions:
            "Keep the empty-thread regression instructions.",
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
        const originalSettings = settings(started);
        expect(typeof started.thread.sessionId).toBe("string");
        expect(started.thread.name).toBeNull();
        const identity = {
          id: threadId,
          sessionId: started.thread.sessionId,
          name: null,
          preview: started.thread.preview,
        };
        expect(started.thread).toMatchObject({
          id: threadId,
          turns: [],
          historyMode,
        });
        expect(
          JSON.stringify(
            await creator.request("mcpServerStatus/list", { threadId }),
          ),
        ).toContain("observe_only");
        // Competing first joins must materialize and retain the same recorder.
        // No thread/name/set or turn/start is sent before or after joining.
        const firstJoins = await Promise.all([
          creator.request("thread/resume", { threadId }),
          peer.request("thread/resume", { threadId, excludeTurns: true }),
        ]);
        for (const joined of firstJoins) {
          expect(joined.thread).toMatchObject({
            ...identity,
            turns: [],
            historyMode,
          });
          expect(settings(joined)).toEqual(originalSettings);
        }
        for (const excludeTurns of [false, true]) {
          const joined = await peer.request("thread/resume", {
            threadId,
            excludeTurns,
          });
          expect(joined.thread).toMatchObject({
            ...identity,
            turns: [],
            historyMode,
          });
          expect(settings(joined)).toEqual(originalSettings);
        }
        const concurrent = await Promise.all([
          creator.request("thread/resume", { threadId }),
          peer.request("thread/resume", { threadId, excludeTurns: true }),
        ]);
        for (const result of concurrent) {
          expect(result.thread).toMatchObject({ ...identity, turns: [] });
          expect(settings(result)).toEqual(originalSettings);
        }
        const loaded = await peer.request("thread/loaded/list", {});
        expect(loaded.data).toEqual([threadId]);
        const stale = await peer.raw("thread/resume", {
          threadId,
          path: path.join(f.workspace, "unrelated-rollout.jsonl"),
        });
        expect(stale.error).toBeDefined();
        expect(stale.result).toBeUndefined();
        expect(await peer.request("thread/loaded/list", {})).toMatchObject({
          data: [threadId],
        });
        expect(
          JSON.stringify(
            await peer.request("mcpServerStatus/list", { threadId }),
          ),
        ).toContain("observe_only");

        await creator.request("thread/settings/update", {
          threadId,
          effort: "medium",
        });
        await vi.waitFor(
          () => {
            for (const client of [creator, peer]) {
              expect(
                client.messages.some(
                  (message) =>
                    message.method === "thread/settings/updated" &&
                    message.params.threadId === threadId &&
                    message.params.threadSettings.effort === "medium",
                ),
              ).toBe(true);
            }
          },
          { timeout: 5_000 },
        );
        await peer.disconnect();
        const reconnected = await f.connect();
        const rejoined = await reconnected.request("thread/resume", {
          threadId,
          excludeTurns: true,
        });
        expect(rejoined.thread).toMatchObject({ ...identity, turns: [] });
        expect(rejoined.reasoningEffort).toBe("medium");
        expect(settings(rejoined)).toEqual({
          ...originalSettings,
          reasoningEffort: "medium",
        });
        expect(
          await reconnected.request("thread/loaded/list", {}),
        ).toMatchObject({ data: [threadId] });
        expect(
          f.clients
            .flatMap((client) => client.messages)
            .filter((message) => message.method === "turn/started"),
        ).toEqual([]);
        expect(f.providerRequests).toEqual([]);
        const mcpCalls = await readFile(f.mcpLog, "utf8");
        expect(mcpCalls).toContain('"initialize"');
        expect(mcpCalls).toContain('"tools/list"');
        expect(mcpCalls).not.toContain('"tools/call"');
      } finally {
        await f.cleanup();
      }
    },
    45_000,
  );

  it("does not invent a durable session for a missing or ephemeral thread", async () => {
    const f = await fixture();
    try {
      const creator = await f.connect();
      const peer = await f.connect();
      const missing = await peer.raw("thread/resume", {
        threadId: "00000000-0000-4000-8000-000000000000",
      });
      expect(missing.error).toMatchObject({ code: -32600 });
      expect(await peer.request("thread/loaded/list", {})).toMatchObject({
        data: [],
      });
      const started = await creator.request("thread/start", {
        cwd: f.workspace,
        ephemeral: true,
      });
      const resumed = await peer.raw("thread/resume", {
        threadId: started.thread.id,
      });
      expect(resumed.error).toMatchObject({ code: -32600 });
      expect(await peer.request("thread/loaded/list", {})).toMatchObject({
        data: [started.thread.id],
      });
      expect(f.providerRequests).toEqual([]);
      expect(
        f.clients
          .flatMap((client) => client.messages)
          .filter((message) => message.method === "turn/started"),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }, 45_000);

  it("retries pending metadata after a failed write with an already visible rollout", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const f = await fixture();
    try {
      const creator = await f.connect();
      const peer = await f.connect();
      const started = await creator.request("thread/start", {
        cwd: f.workspace,
        historyMode: "paginated",
      });
      // This pinned native runtime stores thread metadata here. Open the existing
      // database only; a wrong schema/path must fail instead of creating a fixture.
      const databasePath = path.join(f.home, "state_5.sqlite");
      expect((await stat(databasePath)).isFile()).toBe(true);
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`
          CREATE TRIGGER test_reject_thread_metadata BEFORE INSERT ON threads
          BEGIN SELECT RAISE(FAIL, 'test metadata write obstruction'); END;
        `);
        const failed = await peer.raw("thread/resume", {
          threadId: started.thread.id,
        });
        expect(failed.result).toBeUndefined();
        expect(failed.error, JSON.stringify(failed.error)).toMatchObject({
          code: -32603,
        });
        expect(failed.error.message).toContain(
          "test metadata write obstruction",
        );
        // The file was committed before metadata failed: this is the successful
        // read branch on retry, not another missing-rollout fallback.
        expect((await stat(started.thread.path)).isFile()).toBe(true);
        expect(
          database
            .prepare("SELECT id FROM threads WHERE id = ?")
            .all(started.thread.id),
        ).toEqual([]);
        database.exec("DROP TRIGGER test_reject_thread_metadata");
        const recovered = await peer.request("thread/resume", {
          threadId: started.thread.id,
        });
        expect(recovered.thread).toMatchObject({
          id: started.thread.id,
          sessionId: started.thread.sessionId,
          name: null,
          turns: [],
          historyMode: "paginated",
        });
        expect(settings(recovered)).toEqual(settings(started));
        expect(
          database
            .prepare("SELECT id FROM threads WHERE id = ?")
            .all(started.thread.id),
        ).toHaveLength(1);
        expect(await peer.request("thread/loaded/list", {})).toMatchObject({
          data: [started.thread.id],
        });
        expect(f.providerRequests).toEqual([]);
        expect(
          f.clients
            .flatMap((client) => client.messages)
            .filter((message) => message.method === "turn/started"),
        ).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await f.cleanup();
    }
  }, 45_000);

  it.each(["legacy", "paginated"])(
    "surfaces a real %s storage error and resumes the same thread after repair",
    async (historyMode) => {
      const f = await fixture();
      try {
        const creator = await f.connect();
        const peer = await f.connect();
        const started = await creator.request("thread/start", {
          cwd: f.workspace,
          historyMode,
        });
        const rolloutPath = started.thread.path;
        expect(typeof rolloutPath).toBe("string");
        // Use only the path returned by this disposable native thread. The empty
        // recorder has not written it; a directory there forces actual storage
        // I/O to fail. That error must not be treated as a missing rollout.
        await expect(stat(rolloutPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await mkdir(rolloutPath, { recursive: true });
        const resumed = await peer.raw("thread/resume", {
          threadId: started.thread.id,
        });
        expect(resumed.error).toBeDefined();
        expect(resumed.error.message).not.toContain("no rollout found");
        expect(resumed.result).toBeUndefined();
        expect(await peer.request("thread/loaded/list", {})).toMatchObject({
          data: [started.thread.id],
        });
        // Repair the fixture's storage obstruction and retry the same live thread;
        // failure must not require a replacement process or a synthetic turn.
        await rm(rolloutPath, { recursive: true });
        const recovered = await peer.request("thread/resume", {
          threadId: started.thread.id,
        });
        expect(recovered.thread).toMatchObject({
          id: started.thread.id,
          sessionId: started.thread.sessionId,
          name: null,
          turns: [],
          historyMode,
        });
        expect(settings(recovered)).toEqual(settings(started));
        expect(f.providerRequests).toEqual([]);
        expect(
          f.clients
            .flatMap((client) => client.messages)
            .filter((message) => message.method === "turn/started"),
        ).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
    45_000,
  );
});
