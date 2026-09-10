import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
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
    const force = setTimeout(() => this.socket.terminate(), 1_000);
    try {
      this.socket.close();
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
}

const mcpFixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const tool = process.env.CANTRIP_TEST_TOOL_NAME || 'observe_only';
const generation = process.env.CANTRIP_TEST_GENERATION || 'catalog-only';
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method:request.method,generation,pid:process.pid})+'\n');
  if(request.id===undefined)return;
  const result=request.method==='initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'empty-thread-fixture',version:'1'}}
    : request.method==='tools/list'
      ? {tools:[{name:tool,description:'Returns only this isolated fixture generation.',inputSchema:{type:'object',properties:{}}}]}
      : request.method==='tools/call'
        ? request.params.name===tool && process.env.CANTRIP_TEST_CREDENTIAL==='fixture-credential-'+generation
          ? {content:[{type:'text',text:generation}],isError:false}
          : {content:[{type:'text',text:'Invalid fixture generation credential.'}],isError:true}
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
    const errors: unknown[] = [];
    const clean = async (task: () => unknown | Promise<unknown>) => {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all(
      clients.map((client) => clean(() => client.disconnect())),
    );
    await clean(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const force = setTimeout(() => child?.kill("SIGKILL"), 2_000);
        try {
          child.kill("SIGTERM");
          await closed;
        } finally {
          clearTimeout(force);
        }
      }
    });
    for (const reader of readers) await clean(() => reader.close());
    await clean(async () => {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    await clean(() => rm(root, { recursive: true, force: true }));
    if (errors.length)
      throw new AggregateError(errors, "Native fixture cleanup failed");
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
        // Keep the native fixture independent of external marketplace clones.
        "features.plugins = false",
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
  it("applies managed configuration to the bound engine while peers and sibling sessions stay intact", async () => {
    const f = await fixture();
    try {
      const creator = await f.connect();
      const peer = await f.connect();
      const mcpConfig = (generation: string, tool: string) => ({
        command: process.execPath,
        args: [f.mcp, f.mcpLog],
        required: true,
        env: {
          CANTRIP_TEST_GENERATION: generation,
          CANTRIP_TEST_TOOL_NAME: tool,
          CANTRIP_TEST_CREDENTIAL: `fixture-credential-${generation}`,
        },
      });
      const invalidStartupProfiles = () => {
        const complete: JsonObject = {
          mcpServers: {
            must_not_start: mcpConfig("rejected", "rejected_tool"),
          },
          developerInstructions: "Must not publish rejected instructions.",
          multiAgentEnabled: true,
          subagentModel: "rejected-child",
          subagentReasoningEffort: "medium",
        };
        const missingNullable = { ...complete };
        delete missingNullable.developerInstructions;
        return [
          {
            ...complete,
            mcpServers: {
              ...complete.mcpServers,
              invalid: { command: 42 },
            },
          },
          { ...complete, unexpected: true },
          missingNullable,
        ];
      };
      const mcpLog = () =>
        readFile(f.mcpLog, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      const rejectBeforeStartup = async (
        method: "thread/start" | "thread/resume",
        params: JsonObject,
      ) => {
        const loadedBefore = await creator.request("thread/loaded/list", {});
        const listedIds = async () =>
          (await creator.request("thread/list", {})).data
            .map((thread: JsonObject) => thread.id)
            .sort();
        const idsBefore = await listedIds();
        const logBefore = await mcpLog();
        const configBefore = await readFile(
          path.join(f.home, "config.toml"),
          "utf8",
        );
        const notificationsBefore = peer.messages.length;
        for (const managedConfig of invalidStartupProfiles()) {
          const rejected = await creator.raw(method, {
            ...params,
            managedConfig,
          });
          expect(rejected.error).toBeDefined();
          expect(rejected.result).toBeUndefined();
          expect(await creator.request("thread/loaded/list", {})).toEqual(
            loadedBefore,
          );
          expect(await listedIds()).toEqual(idsBefore);
          expect(await mcpLog()).toBe(logBefore);
          expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(
            configBefore,
          );
          expect(
            peer.messages
              .slice(notificationsBefore)
              .filter((message) =>
                ["thread/started", "turn/started"].includes(message.method),
              ),
          ).toEqual([]);
        }
      };
      await rejectBeforeStartup("thread/start", {
        cwd: f.workspace,
        model: "gpt-5",
        modelProvider: "empty_fixture",
      });
      const started = await creator.request("thread/start", {
        cwd: f.workspace,
        model: "gpt-5",
        modelProvider: "empty_fixture",
        approvalPolicy: "on-request",
        sandbox: "read-only",
        developerInstructions: "Initial managed fixture instructions.",
        config: {
          model_reasoning_effort: "high",
          "features.fast_mode": true,
          "mcp_servers.managed_old": mcpConfig("initial", "initial_tool"),
        },
      });
      const threadId = started.thread.id as string;
      await peer.request("thread/resume", { threadId });
      const sibling = await creator.request("thread/start", {
        cwd: f.workspace,
        model: "gpt-5",
        modelProvider: "empty_fixture",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { "mcp_servers.sibling": mcpConfig("sibling", "sibling_tool") },
      });
      const siblingId = sibling.thread.id as string;
      await peer.request("thread/resume", { threadId: siblingId });
      const configBefore = await readFile(
        path.join(f.home, "config.toml"),
        "utf8",
      );
      const collaborationMode = {
        mode: "plan",
        settings: {
          model: "gpt-5",
          reasoning_effort: "high",
          developer_instructions: "Keep the selected plan mode instructions.",
        },
      };
      await creator.request("thread/settings/update", {
        threadId,
        collaborationMode,
        personality: "pragmatic",
        serviceTier: "flex",
      });
      await vi.waitFor(
        () => {
          expect(
            peer.messages.some(
              (message) =>
                message.method === "thread/settings/updated" &&
                message.params.threadId === threadId,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
      const baselineSettings = [...peer.messages]
        .reverse()
        .find(
          (message) =>
            message.method === "thread/settings/updated" &&
            message.params.threadId === threadId,
        )!.params.threadSettings;
      expect(baselineSettings.collaborationMode).toEqual(collaborationMode);
      expect(baselineSettings.serviceTier).toBe("flex");
      const originalRootSettings = settings(
        await creator.request("thread/resume", { threadId }),
      );
      const siblingSettings = settings(
        await creator.request("thread/resume", { threadId: siblingId }),
      );
      let siblingCatalogRequests = 0;
      const catalog = (id: string) => {
        if (id === siblingId) siblingCatalogRequests++;
        return creator.request("mcpServerStatus/list", { threadId: id });
      };
      const siblingCatalog = await catalog(siblingId);
      const call = async (
        id: string,
        server: string,
        tool: string,
        generation: string,
      ) => {
        expect(
          await creator.request("mcpServer/tool/call", {
            threadId: id,
            server,
            tool,
            arguments: {},
          }),
        ).toMatchObject({
          content: [{ type: "text", text: generation }],
          isError: false,
        });
      };
      expect(JSON.stringify(await catalog(threadId))).toContain("initial_tool");
      await call(threadId, "managed_old", "initial_tool", "initial");
      await call(siblingId, "sibling", "sibling_tool", "sibling");
      const initialLog = (await readFile(f.mcpLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const siblingLogBefore = initialLog.filter(
        (entry) =>
          entry.generation === "sibling" && entry.method === "initialize",
      );
      expect(siblingLogBefore.length).toBeGreaterThan(0);
      const siblingCallPids = new Set(
        initialLog
          .filter(
            (entry) =>
              entry.generation === "sibling" && entry.method === "tools/call",
          )
          .map((entry) => entry.pid),
      );
      expect(siblingCallPids.size).toBe(1);
      const siblingCatalogRequestsBefore = siblingCatalogRequests;
      const notificationStart = peer.messages.length;
      let childrenConfigured = true;
      const assertPreserved = async () => {
        const before = await creator.request("thread/settings/read", {
          threadId,
        });
        expect(before.threadSettings).toEqual({
          ...baselineSettings,
          multiAgentEnabled: childrenConfigured,
          subagentModel: childrenConfigured ? "fixture-child-model" : null,
          subagentReasoningEffort: childrenConfigured ? "medium" : null,
          settingsVersion: before.threadSettings.settingsVersion,
        });
        expect(before.threadSettings.settingsVersion.epoch).toBe(
          baselineSettings.settingsVersion.epoch,
        );
        expect(
          BigInt(before.threadSettings.settingsVersion.revision),
        ).toBeGreaterThan(BigInt(baselineSettings.settingsVersion.revision));
        const joined = await creator.request("thread/resume", { threadId });
        expect(joined.thread).toMatchObject({
          id: threadId,
          sessionId: started.thread.sessionId,
          turns: [],
        });
        expect(settings(joined)).toEqual(originalRootSettings);
        // Observation must preserve the latest explicit child configuration and
        // its exact settings version, without a mutation to elicit a notification.
        expect(
          await creator.request("thread/settings/read", { threadId }),
        ).toEqual(before);
        const siblingJoined = await creator.request("thread/resume", {
          threadId: siblingId,
        });
        expect(siblingJoined.thread.sessionId).toBe(sibling.thread.sessionId);
        expect(settings(siblingJoined)).toEqual(siblingSettings);
        expect(await catalog(siblingId)).toEqual(siblingCatalog);
        await call(siblingId, "sibling", "sibling_tool", "sibling");
        expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(
          configBefore,
        );
      };
      const managedPayload = (mcpServers: JsonObject) => ({
        threadId,
        mcpServers,
        developerInstructions: "Updated managed fixture instructions.",
        multiAgentEnabled: true,
        subagentModel: "fixture-child-model",
        subagentReasoningEffort: "medium",
      });
      const replace = async (mcpServers: JsonObject) => {
        expect(
          await creator.request(
            "thread/managedConfig/update",
            managedPayload(mcpServers),
          ),
        ).toEqual({ threadId, applied: true });
      };
      await replace({
        managed_new: mcpConfig("generation-one", "replacement_tool"),
      });
      expect(JSON.stringify(await catalog(threadId))).toContain(
        "replacement_tool",
      );
      expect(JSON.stringify(await catalog(threadId))).not.toContain(
        "initial_tool",
      );
      await call(threadId, "managed_new", "replacement_tool", "generation-one");
      await assertPreserved();
      // Same server/tool name, different synthetic credential and env. A
      // cached old client cannot produce the new harmless generation result.
      await replace({
        managed_new: mcpConfig("generation-two", "replacement_tool"),
      });
      await catalog(threadId);
      await call(threadId, "managed_new", "replacement_tool", "generation-two");
      await assertPreserved();
      const catalogBeforeInvalid = await catalog(threadId);
      const omittedNullable: JsonObject = managedPayload({});
      delete omittedNullable.developerInstructions;
      for (const invalid of [
        { ...managedPayload({ managed_new: { command: 42 } }) },
        { ...managedPayload({}), multiAgentEnabled: "false" },
        // Native permits nonempty model-defined efforts; an empty value is invalid.
        { ...managedPayload({}), subagentReasoningEffort: "" },
        { ...managedPayload({}), unexpected: true },
        omittedNullable,
      ]) {
        const rejected = await creator.raw(
          "thread/managedConfig/update",
          invalid,
        );
        expect(rejected.error, JSON.stringify(invalid)).toBeDefined();
        expect(rejected.result, JSON.stringify(invalid)).toBeUndefined();
        expect(await catalog(threadId)).toEqual(catalogBeforeInvalid);
        await call(
          threadId,
          "managed_new",
          "replacement_tool",
          "generation-two",
        );
        await assertPreserved();
      }
      expect(
        await creator.request("thread/managedConfig/update", {
          ...managedPayload({}),
          developerInstructions: null,
          multiAgentEnabled: false,
          subagentModel: null,
          subagentReasoningEffort: null,
        }),
      ).toEqual({ threadId, applied: true });
      expect((await catalog(threadId)).data).toEqual([]);
      const removedCall = await creator.raw("mcpServer/tool/call", {
        threadId,
        server: "managed_new",
        tool: "replacement_tool",
        arguments: {},
      });
      expect(removedCall.error).toBeDefined();
      childrenConfigured = false;
      await assertPreserved();
      expect(
        peer.messages
          .slice(notificationStart)
          .filter(
            (message) =>
              ["thread/closed", "thread/started", "turn/started"].includes(
                message.method,
              ) && message.params?.threadId === threadId,
          ),
      ).toEqual([]);
      expect(await peer.request("thread/unsubscribe", { threadId })).toEqual({
        status: "unsubscribed",
      });
      // Exercise the cold branch: unsubscribe alone retains a loaded engine.
      await creator.request("thread/archive", { threadId });
      await creator.request("thread/unarchive", { threadId });
      await vi.waitFor(
        async () =>
          expect(
            (await creator.request("thread/loaded/list", {})).data,
          ).toEqual([siblingId]),
        { timeout: 5_000 },
      );
      await rejectBeforeStartup("thread/resume", { threadId });
      expect(
        (await creator.request("thread/read", { threadId, includeTurns: true }))
          .thread.turns,
      ).toEqual([]);
      expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(
        configBefore,
      );
      const log = (await readFile(f.mcpLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const siblingInitializations = log.filter(
        (entry) =>
          entry.generation === "sibling" && entry.method === "initialize",
      );
      // Native catalog discovery creates a separate eager connection set per
      // request. Account for those explicit probes while requiring every real
      // invocation to retain the original sibling host and native session.
      expect(siblingInitializations).toHaveLength(
        siblingLogBefore.length +
          siblingCatalogRequests -
          siblingCatalogRequestsBefore,
      );
      expect(
        new Set(
          log
            .filter(
              (entry) =>
                entry.generation === "sibling" && entry.method === "tools/call",
            )
            .map((entry) => entry.pid),
        ),
      ).toEqual(siblingCallPids);
      expect(
        log.filter(
          (entry) =>
            entry.generation === "generation-two" &&
            entry.method === "tools/call",
        ).length,
      ).toBeGreaterThan(0);
      expect(f.providerRequests).toEqual([]);
      expect(
        f.clients
          .flatMap((client) => client.messages)
          .filter((message) => message.method === "turn/started"),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  it("keeps MCP configuration when another view remains subscribed during rejoin", async () => {
    const f = await fixture();
    try {
      const creator = await f.connect();
      const mcpConfig = {
        command: process.execPath,
        args: [f.mcp, f.mcpLog],
        required: true,
      };
      const started = await creator.request("thread/start", {
        cwd: f.workspace,
        approvalPolicy: "on-request",
        config: { "mcp_servers.empty_fixture": mcpConfig },
      });
      const threadId = started.thread.id as string;
      const peer = await f.connect();
      await peer.request("thread/resume", { threadId });
      const catalog = await creator.request("mcpServerStatus/list", {
        threadId,
      });
      expect(JSON.stringify(catalog)).toContain("observe_only");

      await creator.request("thread/unsubscribe", { threadId });
      expect((await creator.request("thread/loaded/list", {})).data).toContain(
        threadId,
      );
      const resumed = await creator.request("thread/resume", {
        threadId,
        approvalPolicy: "never",
        config: {
          "mcp_servers.empty_fixture": { ...mcpConfig, enabled: false },
        },
      });

      // Native resume is a view join while another client is subscribed. Worker
      // configuration changes need a real mutation operation; clearing a local
      // loaded-thread cache and resuming cannot establish that they were applied.
      expect(resumed.thread.sessionId).toBe(started.thread.sessionId);
      expect(resumed.approvalPolicy).toBe("on-request");
      expect(
        await creator.request("mcpServerStatus/list", { threadId }),
      ).toEqual(catalog);
      const mcpAfter = await readFile(f.mcpLog, "utf8");
      expect(mcpAfter).not.toContain('"tools/call"');
      expect(f.providerRequests).toEqual([]);
      expect(
        creator.messages.filter((message) => message.method === "turn/started"),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }, 45_000);

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
        const metadataModel = () =>
          database
            .prepare("SELECT model FROM threads WHERE id = ?")
            .get(started.thread.id)?.model;
        expect(metadataModel()).toBe(started.model);
        database.exec(`
          CREATE TRIGGER test_reject_thread_metadata BEFORE INSERT ON threads
          BEGIN SELECT RAISE(FAIL, 'test metadata write obstruction'); END;
        `);
        // Startup now persists an owned settings snapshot and its initial row.
        // Make a later non-turn snapshot produce pending metadata under a real
        // SQLite fault, then require attachment to retry that failed projection.
        const updatedModel = "fixture-storage-model";
        await creator.request("thread/settings/update", {
          threadId: started.thread.id,
          model: updatedModel,
        });
        await vi.waitFor(
          () =>
            expect(
              creator.messages.some(
                (message) =>
                  message.method === "thread/settings/updated" &&
                  message.params.threadSettings.model === updatedModel,
              ),
            ).toBe(true),
          { timeout: 5_000 },
        );
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
        // The file remains visible while SQLite still contains the old model:
        // this exercises the successful-read attachment barrier on retry.
        expect((await stat(started.thread.path)).isFile()).toBe(true);
        expect(await readFile(started.thread.path, "utf8")).toContain(
          updatedModel,
        );
        expect(metadataModel()).toBe(started.model);
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
        expect(settings(recovered)).toEqual({
          ...settings(started),
          model: updatedModel,
        });
        expect(
          database
            .prepare("SELECT id FROM threads WHERE id = ?")
            .all(started.thread.id),
        ).toHaveLength(1);
        expect(metadataModel()).toBe(updatedModel);
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
        // Startup materializes the owned settings snapshot. Preserve that exact
        // file while obstructing its returned path with a directory, forcing a
        // real storage read error instead of a missing-rollout fallback.
        expect((await stat(rolloutPath)).isFile()).toBe(true);
        const preservedRollout = `${rolloutPath}.fixture-preserved`;
        await rename(rolloutPath, preservedRollout);
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
        await rename(preservedRollout, rolloutPath);
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
