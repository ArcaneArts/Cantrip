import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";

import {
  CodexAppServer,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { ThreadObservationRegistry } from "../src/codex/thread-observation.js";

import { CodexRpcClient } from "../src/codex/rpc-client.js";

// Opt in with the actual pinned bundle. This never uses an account credential,
// starts a model turn, launches a TUI, or sends computer input.
const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

type JsonObject = Record<string, any>;

const mcpFixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method:request.method})+'\n');
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'observation-fixture',version:'1'}}
    : request.method === 'tools/list'
      ? {tools:[{name:'observe_only',description:'Regression fixture; never invoked.',inputSchema:{type:'object',properties:{}}}]}
      : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`;

function effectiveSettings(response: JsonObject): JsonObject {
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

describe.skipIf(!binary)("pinned native thread observation", () => {
  it("preserves loaded settings and keeps cold metadata observations unloaded", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-thread-observation-"),
    );
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const fixture = path.join(root, "mcp.cjs");
    const mcpLog = path.join(root, "mcp-requests.jsonl");
    const providerRequests: string[] = [];
    const provider = createServer((request, response) => {
      providerRequests.push(request.url ?? "");
      response
        .writeHead(500)
        .end("No model requests are permitted in this test.");
    });
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: CodexRpcClient | undefined;
    let closed: Promise<void> | undefined;
    const closeOwnedChild = async (requestClose: () => void) => {
      const owned = child;
      const force = setTimeout(() => owned?.kill("SIGKILL"), 2_000);
      try {
        requestClose();
        await closed;
      } finally {
        clearTimeout(force);
      }
    };
    try {
      await Promise.all([
        mkdir(home),
        mkdir(workspace),
        writeFile(fixture, mcpFixture),
      ]);
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const address = provider.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture address");
      await writeFile(
        path.join(home, "config.toml"),
        [
          'model = "gpt-5"',
          'model_provider = "observation"',
          'approval_policy = "never"',
          'sandbox_mode = "read-only"',
          "[features]",
          "goals = true",
          "plugins = false",
          "[model_providers.observation]",
          'name = "Observation fixture"',
          `base_url = "http://127.0.0.1:${address.port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "request_max_retries = 0",
          "stream_max_retries = 0",
          "",
        ].join("\n"),
      );
      child = spawn(binary!, ["app-server"], {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: "pipe",
      });
      closed = new Promise<void>((resolve) =>
        child!.once("close", () => resolve()),
      );
      const notifications: JsonObject[] = [];
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.method) notifications.push(message);
        } catch {
          /* Native logging is not protocol JSON. */
        }
      });
      client = new CodexRpcClient(child, 15_000);
      const request = async (
        method: string,
        params: JsonObject,
      ): Promise<JsonObject> => {
        const response = await client!.request(method, params);
        if (response.error)
          throw new Error(`${method}: ${JSON.stringify(response.error)}`);
        return response.result as JsonObject;
      };
      await request("initialize", {
        clientInfo: { name: "cantrip_native_observation_test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
      const started = await request("thread/start", {
        historyMode: "paginated",
        cwd: workspace,
        model: "gpt-5",
        modelProvider: "observation",
        approvalPolicy: "on-request",
        sandbox: "read-only",
        developerInstructions: "Preserve this observation regression marker.",
        config: {
          model_reasoning_effort: "high",
          "mcp_servers.observation_fixture": {
            command: process.execPath,
            args: [fixture, mcpLog],
            required: true,
          },
        },
      });
      const threadId = started.thread.id as string;
      expect(started.thread.turns).toEqual([]);
      expect(started.approvalPolicy).toBe("on-request");
      expect(started.reasoningEffort).toBe("high");
      const before = effectiveSettings(started);
      const catalog = await request("mcpServerStatus/list", { threadId });
      expect(JSON.stringify(catalog)).toContain("observe_only");

      const observed = await request("thread/read", {
        threadId,
        includeTurns: false,
      });
      expect(observed.thread).toMatchObject({
        id: threadId,
        model: "gpt-5",
        reasoningEffort: "high",
      });
      expect(await request("thread/goal/get", { threadId })).toEqual({
        goal: null,
      });
      // A second view can join an empty durable thread before naming or input.
      const emptyResume = await request("thread/resume", { threadId });
      expect(emptyResume.thread).toMatchObject({ id: threadId, turns: [] });
      expect(effectiveSettings(emptyResume)).toEqual(before);
      // Naming still persists this disposable fixture for the cold-read check.
      await request("thread/name/set", {
        threadId,
        name: "Observation regression",
      });
      const resumed = await request("thread/resume", { threadId });
      expect(resumed.thread.id).toBe(threadId);
      expect(resumed.thread.turns).toEqual([]);
      expect(effectiveSettings(resumed)).toEqual(before);
      expect(
        JSON.stringify(await request("mcpServerStatus/list", { threadId })),
      ).toContain("observe_only");

      // Plan mode has an applied-settings notification, not a settings/read RPC.
      // Observe that notification and ensure unrelated reads do not revert it.
      await request("thread/settings/update", {
        threadId,
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
      });
      const applied = await client.waitForNotification(
        "thread/settings/updated",
        (params) =>
          (params as JsonObject).threadId === threadId &&
          (params as JsonObject).threadSettings.collaborationMode.mode ===
            "plan",
      );
      expect(
        (applied.params as JsonObject).threadSettings.collaborationMode.mode,
      ).toBe("plan");
      const appliedCount = notifications.filter(
        (event) => event.method === "thread/settings/updated",
      ).length;
      await request("thread/read", { threadId, includeTurns: false });
      await request("thread/goal/get", { threadId });
      const after = await request("thread/resume", { threadId });
      expect(effectiveSettings(after)).toEqual(before);
      await request("thread/read", { threadId, includeTurns: false });
      expect(
        notifications.filter(
          (event) => event.method === "thread/settings/updated",
        ),
      ).toHaveLength(appliedCount);
      // Force a separately acknowledged settings snapshot without changing mode.
      // Its applied notification proves the plan mode survived every observation.
      await request("thread/settings/update", { threadId, effort: "medium" });
      const confirmed = await client.waitForNotification(
        "thread/settings/updated",
        (params) =>
          (params as JsonObject).threadId === threadId &&
          (params as JsonObject).threadSettings.effort === "medium",
      );
      expect(
        (confirmed.params as JsonObject).threadSettings.collaborationMode.mode,
      ).toBe("plan");
      expect(
        notifications.filter((event) => event.method === "turn/started"),
      ).toEqual([]);
      expect(providerRequests).toEqual([]);
      expect(await readFile(mcpLog, "utf8")).not.toContain('"tools/call"');
      await closeOwnedChild(() => client!.close());
      lines.close();

      // A worker restart leaves this named thread durable but not loaded.
      // Reading its absent goal must not resume it or initialize its MCP again.
      const mcpBeforeRestart = await readFile(mcpLog, "utf8");
      child = spawn(binary!, ["app-server"], {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: "pipe",
      });
      closed = new Promise<void>((resolve) =>
        child!.once("close", () => resolve()),
      );
      client = new CodexRpcClient(child, 15_000);
      await request("initialize", {
        clientInfo: { name: "cantrip_native_observation_test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
      expect(await request("thread/loaded/list", {})).toEqual({
        data: [],
        nextCursor: null,
      });
      expect(await request("thread/goal/get", { threadId })).toEqual({
        goal: null,
      });
      expect(await request("thread/loaded/list", {})).toEqual({
        data: [],
        nextCursor: null,
      });
      expect(await readFile(mcpLog, "utf8")).toBe(mcpBeforeRestart);
      expect(providerRequests).toEqual([]);
      await closeOwnedChild(() => client!.close());
      child = undefined;
      client = undefined;

      // A Plan GET through the real worker must stay observational even when
      // cold resume would initialize an inherited account MCP server. Native
      // Plan Mode is persisted as plan above; this is only a display fallback.
      await appendFile(
        path.join(home, "config.toml"),
        [
          "[mcp_servers.inherited_observation]",
          `command = ${JSON.stringify(process.execPath)}`,
          `args = ${JSON.stringify([fixture, mcpLog])}`,
          "required = true",
          "",
        ].join("\n"),
      );
      const compatibility = await discoverCodexRuntime(binary!, home);
      const launch: CodexProcessLauncher = (executable, args, options) => {
        child = spawn(executable, args, {
          cwd: workspace,
          env: { ...options.env, HOME: home, CODEX_HOME: home },
          stdio: "pipe",
        });
        closed = new Promise<void>((resolve) =>
          child!.once("close", () => resolve()),
        );
        return child;
      };
      const worker = new CodexAppServer(
        binary!,
        path.join(root, "worker"),
        home,
        compatibility,
        undefined,
        undefined,
        undefined,
        launch,
      );
      const model = {
        id: "model",
        routeId: "route",
        name: "gpt-5",
        reasoningEffort: null,
      };
      const runtimeProvider = {
        id: "provider",
        name: "Local observation fixture",
        kind: "openai" as const,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-not-a-real-key",
      };
      const inheritedLogBefore = await readFile(mcpLog, "utf8");
      // After a worker restart there is no live runtime binding. A real root
      // reader must find the durable thread in its home without loading its
      // session, reconstructing a child profile, or starting inherited MCP.
      const observations = new ThreadObservationRegistry();
      expect(
        await observations.sync(
          {
            serverId: "server",
            ownerId: "owner",
            workerId: "worker",
            chatId: "chat",
            threadId,
            cwd: workspace,
            modelRouteId: model.routeId,
            providerId: runtimeProvider.id,
            providerKind: runtimeProvider.kind,
            providerAccountId: null,
            credentialHomeKey: null,
          },
          () =>
            worker.syncThread({
              cwd: workspace,
              model,
              provider: runtimeProvider,
              threadId,
              executionProfile: "ide",
            }),
        ),
      ).toMatchObject({ threadId, status: "idle", turns: [] });
      // Exercise the real native transport only to inspect loaded identities.
      const native = worker as unknown as {
        request(method: string, params: JsonObject): Promise<JsonObject>;
      };
      expect(await native.request("thread/loaded/list", {})).toEqual({
        data: [],
        nextCursor: null,
      });
      expect(
        await worker.getPlanMode({
          cwd: workspace,
          model,
          provider: runtimeProvider,
          permissionProfileId: ":workspace",
          threadId,
          fallbackMode: "default",
        }),
      ).toEqual({ mode: "default", threadId });
      expect(await native.request("thread/loaded/list", {})).toEqual({
        data: [],
        nextCursor: null,
      });
      expect(await readFile(mcpLog, "utf8")).toBe(inheritedLogBefore);
      expect(providerRequests).toEqual([]);
      await closeOwnedChild(() => worker.close());
      child = undefined;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await closeOwnedChild(() => {
          client?.close();
          child!.kill("SIGTERM");
        });
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
