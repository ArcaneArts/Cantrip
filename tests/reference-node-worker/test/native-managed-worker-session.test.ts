import { readProtectedNativeSettings } from "../src/native-settings-read.js";
import { openNativeSettingsSnapshot } from "../src/native-settings-content.js";
import {
  readNativeAccountDefaults,
  writeNativeAccountDefaults,
  nativeAccountDefaultsParams,
} from "../src/codex/native-account-defaults.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  CANTRIP_MCP_TOOL_NAMES,
  MANAGED_CUA_MCP_NAME,
  type McpServerConfiguration,
  type NativeModelInventory,
} from "@cantrip/protocol";
import {
  CodexAppServer,
  type CodexProcessLauncher,
  type PrepareManagedThreadOptions,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { ThreadObservationRegistry } from "../src/codex/thread-observation.js";
import {
  ManagedSessionCoordinator,
  type ManagedSessionPreparation,
} from "../src/codex/managed-session.js";
import type { CodexRuntimeDiagnostic } from "../src/codex/runtime.js";
import {
  managedCantripMcpServer,
  managedCuaMcpServer,
  mergeManagedMcpServers,
} from "../src/mcp/managed.js";

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
const fs = require('node:fs');
const readline = require('node:readline');
const role = process.env.CANTRIP_TEST_ROLE;
const generation = process.env.CANTRIP_TEST_GENERATION;
const tools = JSON.parse(process.env.CANTRIP_TEST_TOOLS);
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method:request.method,role,generation,pid:process.pid})+'\n');
  if(request.id===undefined)return;
  const result=request.method==='initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'managed-worker-fixture',version:'1'}}
    : request.method==='tools/list'
      ? {tools:[...tools,'excluded_fixture'].map(name=>({name,description:'Returns only an isolated fixture generation.',inputSchema:{type:'object',properties:{}}}))}
      : request.method==='tools/call'
        ? tools.includes(request.params.name) && process.env.CANTRIP_TEST_CREDENTIAL==='fixture-credential-'+generation
          ? {content:[{type:'text',text:role+':'+generation}],isError:false}
          : {content:[{type:'text',text:'Invalid fixture credential.'}],isError:true}
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

// Actual worker coordinator/runtime, binary, catalog discovery and MCP hosts.
// The process-launch seam only isolates HOME/cwd and records owned children;
// no native request, response, runtime method or readiness result is mocked.
describe.skipIf(!binary)(
  "production managed worker with pinned native runtime",
  () => {
    it("prepares one session and refreshes managed credentials without restoring stale view settings", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-worker-"));
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const data = path.join(root, "data");
      const journal = path.join(root, "managed-sessions");
      const script = path.join(root, "mcp.cjs");
      const log = path.join(root, "mcp.jsonl");
      const providerRequests: string[] = [];
      const provider = createServer((request, response) => {
        providerRequests.push(request.url ?? "");
        response
          .writeHead(500)
          .end("This session test must not perform inference.");
      });
      const children: ChildProcessWithoutNullStreams[] = [];
      const clients: RemoteClient[] = [];
      const diagnostics: CodexRuntimeDiagnostic[] = [];
      let runtime: CodexAppServer | undefined;
      let inventory: NativeModelInventory | null = null;
      let inventoryUnavailable = false;
      const loadInventory = vi.fn(async () => {
        if (inventoryUnavailable || !inventory)
          throw new Error("Fixture inventory unavailable");
        return inventory;
      });
      const stopRuntime = async () => {
        const child = children.at(-1);
        const exited =
          child && child.exitCode === null && child.signalCode === null
            ? once(child, "exit")
            : Promise.resolve();
        const force = setTimeout(() => child?.kill("SIGKILL"), 2_000);
        try {
          try {
            runtime?.close();
          } finally {
            await exited;
          }
        } finally {
          clearTimeout(force);
        }
      };
      const readMcpLog = async () =>
        (await readFile(log, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as JsonObject);
      const inheritedInitializations = (entries: JsonObject[]) =>
        entries.filter(
          (entry) =>
            entry.role === "inherited" && entry.method === "initialize",
        );
      const bodyFailures: unknown[] = [];
      try {
        await Promise.all([
          mkdir(home),
          mkdir(workspace),
          mkdir(data),
          writeFile(script, mcpFixture),
        ]);
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("Missing provider fixture port");
        const environment = (
          role: string,
          generation: string,
          tools: string[],
        ) => ({
          CANTRIP_TEST_ROLE: role,
          CANTRIP_TEST_GENERATION: generation,
          CANTRIP_TEST_CREDENTIAL: `fixture-credential-${generation}`,
          CANTRIP_TEST_TOOLS: JSON.stringify(tools),
        });
        const initialConfig = [
          'model="gpt-5"',
          // Only local synthetic MCP services participate in this fixture.
          "features.plugins=false",
          'model_provider="fixture"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "[model_providers.fixture]",
          'name="Local rejecting fixture"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "request_max_retries=0",
          "stream_max_retries=0",
          "[mcp_servers.inherited]",
          `command=${JSON.stringify(process.execPath)}`,
          `args=${JSON.stringify([script, log])}`,
          "[mcp_servers.inherited.env]",
          ...Object.entries(
            environment("inherited", "home", ["home_tool"]),
          ).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
          "",
        ].join("\n");
        await writeFile(path.join(home, "config.toml"), initialConfig);
        const compatibility = await discoverCodexRuntime(binary!, home);
        const launch: CodexProcessLauncher = (executable, args, options) => {
          const child = spawn(executable, args, {
            cwd: workspace,
            env: { ...options.env, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          children.push(child);
          return child;
        };
        const createRuntime = () => {
          const instance = new CodexAppServer(
            binary!,
            data,
            home,
            compatibility,
            (entry) => diagnostics.push(entry),
            undefined,
            undefined,
            launch,
          );
          instance.setManagedModelInventoryLoader(loadInventory);
          return instance;
        };
        runtime = createRuntime();
        const invocation = {
          command: process.execPath,
          arguments: [script, log],
        };
        const cantripTool = CANTRIP_MCP_TOOL_NAMES[0]!;
        const managedServers = (
          generation: string,
        ): McpServerConfiguration[] => {
          const cua = managedCuaMcpServer(
            invocation,
            path.join(root, "fake-cua-connection"),
            generation,
          );
          cua.environment = {
            ...cua.environment,
            ...environment(MANAGED_CUA_MCP_NAME, generation, [
              "js",
              "js_reset",
            ]),
          };
          const cantrip = managedCantripMcpServer(
            invocation,
            path.join(root, "fake-cantrip-connection"),
            [cantripTool],
            "ide",
            generation,
          );
          cantrip.environment = {
            ...cantrip.environment,
            ...environment("cantrip", generation, [cantripTool]),
          };
          const stdio = (
            name: string,
            tools: string[],
          ): McpServerConfiguration => ({
            name,
            enabled: true,
            transport: "stdio",
            command: process.execPath,
            args: [script, log],
            environment: environment(name, generation, tools),
          });
          return mergeManagedMcpServers(
            [
              stdio("custom", ["custom_tool"]),
              stdio(MANAGED_CUA_MCP_NAME, ["wrong_reserved_tool"]),
            ],
            [cua, cantrip, stdio("codegraph", ["codegraph_explore"])],
          );
        };
        const model = {
          id: "model",
          routeId: "fixture-route",
          name: "gpt-5",
          reasoningEffort: "high" as const,
        };
        const runtimeProvider = {
          id: "provider",
          name: "Local fixture",
          kind: "openai-compatible" as const,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "synthetic-provider-key",
          accountId: "fixture-account",
          credentialHomeKey: "fixture-home",
        };
        inventory = {
          workerId: "worker",
          providerId: runtimeProvider.id,
          providerKind: runtimeProvider.kind,
          providerAccountId: runtimeProvider.accountId,
          models: [
            {
              ...model,
              id: "inventory-custom",
              routeId: "custom-route",
              name: "fixture-custom",
              reasoningEffort: null,
            },
            { ...model, id: "inventory-alias", routeId: "alias-route" },
          ],
        };
        const configuration: PrepareManagedThreadOptions = {
          cwd: workspace,
          threadId: null,
          executionProfile: "ide",
          intent: "configure",
          permissionProfileId: ":workspace",
          model,
          provider: runtimeProvider,
          mcpServers: managedServers("one"),
          planMode: "default",
          subagentDefaults: {
            model: {
              ...model,
              id: "child",
              name: "fixture-child",
              reasoningEffort: "medium",
            },
            provider: runtimeProvider,
          },
        };
        const identified: string[] = [];
        const input: ManagedSessionPreparation = {
          identity: {
            serverId: "server",
            ownerId: "owner",
            workerId: "worker",
            chatId: "chat",
            placementId: "worktree",
            projectId: "project",
            contextKind: "project",
          },
          configuration,
          runtime,
          onThreadIdentified: async (id) => {
            identified.push(id);
            await writeFile(
              path.join(root, "canonical-association.json"),
              JSON.stringify({ threadId: id }),
            );
          },
        };
        let coordinator = new ManagedSessionCoordinator(journal);
        const preparations = await Promise.allSettled([
          coordinator.prepare(input),
          coordinator.prepare({
            ...input,
            configuration: { ...configuration, intent: "preserve" },
          }),
        ]);
        const completed = preparations.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        const prepared = completed[0]!;
        // Native creation records project trust for a writable new thread.
        // Attachment and subsequent root settings changes must not write any
        // further account defaults, so compare against the created session.
        const configuredAccountConfig = await readFile(
          path.join(home, "config.toml"),
          "utf8",
        );
        const joinedPreparation = completed[1]!;
        const threadId = prepared.threadId;
        expect(joinedPreparation).toEqual(prepared);
        expect(new Set(identified)).toEqual(new Set([threadId]));
        expect(
          JSON.parse(
            await readFile(
              path.join(root, "canonical-association.json"),
              "utf8",
            ),
          ),
        ).toEqual(prepared);
        expect(children).toHaveLength(1);
        const endpoint = await runtime.remoteEndpoint(
          model,
          runtimeProvider,
          configuration,
        );
        const connect = async (url = endpoint) => {
          const socket = new WebSocket(url);
          await once(socket, "open");
          const client = new RemoteClient(socket);
          clients.push(client);
          await client.request("initialize", {
            clientInfo: { name: "cantrip_worker_native_view", version: "1" },
            capabilities: { experimentalApi: true },
          });
          socket.send(JSON.stringify({ method: "initialized" }));
          return client;
        };
        let first = await connect();
        let second = await connect();
        const initialSettingsRead =
          await runtime.readNativeThreadSettings(threadId);
        const initialSettingsVersion =
          initialSettingsRead.confirmed!.settings.settingsVersion!;
        expect(initialSettingsVersion).toEqual({
          epoch: expect.any(String),
          revision: expect.stringMatching(/^[0-9]+$/),
        });
        expect(
          (await runtime.readNativeThreadSettings(threadId)).confirmed
            ?.settings,
        ).toEqual(initialSettingsRead.confirmed!.settings);

        const attributionScope = {
          workerId: "worker",
          modelRouteId: model.routeId,
          providerAccountId: runtimeProvider.accountId,
        };
        expect(
          runtime.getManagedModelAttribution(
            initialSettingsRead.confirmed!.settings.model,
            attributionScope,
          ),
        ).toMatchObject({
          status: "resolved",
          modelId: model.id,
          routeId: model.routeId,
        });
        expect(
          runtime.getManagedModelAttribution(
            "fixture-custom",
            attributionScope,
          ),
        ).toMatchObject({
          status: "resolved",
          modelId: "inventory-custom",
          routeId: "custom-route",
        });
        expect(
          runtime.getManagedModelAttribution("gpt-5", {
            ...attributionScope,
            providerAccountId: "different-account",
          }),
        ).toEqual({ status: "unavailable" });
        const picker = await first.request("model/list", {});
        expect(picker.data.map((entry: JsonObject) => entry.model)).toEqual([
          "gpt-5",
          "fixture-child",
          "fixture-custom",
        ]);
        expect(loadInventory).toHaveBeenCalledTimes(1);
        expect(runtime.getManagedModelInventory()).toEqual(inventory);
        const firstJoined = await first.request("thread/resume", { threadId });
        const secondJoined = await second.request("thread/resume", {
          threadId,
        });
        const modelScope = {
          ...attributionScope,
          chatId: "fixture-chat",
          threadId,
          contextKind: "project" as const,
          projectId: "project",
          placementId: "placement",
        };
        const modelService = {
          ownerId: () => "owner",
          serverIdentity: () => "server",
          componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 33) }),
        };
        for (const [name, routeId] of [
          ["fixture-custom", "custom-route"],
          [model.name, model.routeId],
        ]) {
          const offset = second.messages.length;
          await first.request("thread/settings/update", {
            threadId,
            model: name,
          });
          await vi.waitFor(
            () =>
              expect(
                second.messages
                  .slice(offset)
                  .some(
                    (entry) =>
                      entry.method === "thread/settings/updated" &&
                      entry.params.threadSettings.model === name,
                  ),
              ).toBe(true),
            { timeout: 5000 },
          );
          const snapshot = await readProtectedNativeSettings({
            scope: modelScope,
            service: modelService,
            resolve: () => ({
              scope: modelScope,
              runtime: runtime!,
              generation: runtime!.transportGeneration!,
            }),
          });
          expect(snapshot.modelAttribution!.selection).toMatchObject({
            status: "resolved",
            routeId,
          });
          expect(
            (
              await openNativeSettingsSnapshot({
                service: modelService,
                context: snapshot.context,
                snapshot,
              })
            ).model,
          ).toBe(name);
          expect(modelScope.modelRouteId).toBe(model.routeId);
        }
        let engineSessionId = firstJoined.thread.sessionId;
        expect(typeof engineSessionId).toBe("string");
        expect(secondJoined.thread.sessionId).toBe(engineSessionId);
        expect((await first.request("thread/loaded/list", {})).data).toEqual([
          threadId,
        ]);
        const catalog = async (client: RemoteClient) => {
          const result = await client.request("mcpServerStatus/list", {
            threadId,
          });
          expect(
            result.data.map((server: JsonObject) => server.name).sort(),
          ).toEqual(
            ["cantrip", MANAGED_CUA_MCP_NAME, "codegraph", "custom"].sort(),
          );
          for (const server of result.data.filter(
            (entry: JsonObject) => entry.name !== "custom",
          )) {
            expect(JSON.stringify(server.tools)).not.toContain(
              "excluded_fixture",
            );
            expect(JSON.stringify(server.tools)).not.toContain(
              "wrong_reserved_tool",
            );
          }
          return result;
        };
        const invoke = async (client: RemoteClient, generation: string) => {
          for (const [server, tool] of [
            [MANAGED_CUA_MCP_NAME, "js"],
            ["cantrip", cantripTool],
            ["codegraph", "codegraph_explore"],
            ["custom", "custom_tool"],
          ]) {
            expect(
              await client.request("mcpServer/tool/call", {
                threadId,
                server,
                tool,
                arguments: {},
              }),
            ).toMatchObject({
              content: [{ type: "text", text: `${server}:${generation}` }],
              isError: false,
            });
          }
        };
        await catalog(first);
        await invoke(first, "one");
        const initialLog = await readMcpLog();
        // Exact managed configuration must apply before the first core creates
        // MCP hosts; replacing the final catalog would be too late.
        expect(inheritedInitializations(initialLog)).toEqual([]);
        for (const role of [MANAGED_CUA_MCP_NAME, "cantrip", "codegraph"]) {
          expect(
            initialLog.some(
              (entry) => entry.role === role && entry.method === "tools/list",
            ),
          ).toBe(true);
        }

        const changedAt = second.messages.length;
        await first.request("thread/settings/update", {
          threadId,
          approvalPolicy: "on-request",
          serviceTier: "flex",
          personality: "pragmatic",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "native-selected-model",
              reasoning_effort: "medium",
              developer_instructions: "Keep the native plan selection.",
            },
          },
        });
        await vi.waitFor(
          () =>
            expect(
              second.messages
                .slice(changedAt)
                .some(
                  (entry) =>
                    entry.method === "thread/settings/updated" &&
                    entry.params.threadSettings.model ===
                      "native-selected-model",
                ),
            ).toBe(true),
          { timeout: 5_000 },
        );
        const selectedSettings = second.messages
          .slice(changedAt)
          .find(
            (entry) =>
              entry.method === "thread/settings/updated" &&
              entry.params.threadSettings.model === "native-selected-model",
          )!.params.threadSettings;
        await vi.waitFor(() =>
          expect(
            runtime!.getNativeThreadSettings(threadId).confirmed?.settings,
          ).toEqual(selectedSettings),
        );
        let expectedRoot = settings(
          await second.request("thread/resume", { threadId }),
        );
        expect(expectedRoot).toMatchObject({
          model: "native-selected-model",
          reasoningEffort: "medium",
          serviceTier: "flex",
          approvalPolicy: "on-request",
        });
        const assertSelected = async () => {
          const resumed = await second.request("thread/resume", { threadId });
          expect(resumed.thread.sessionId).toBe(engineSessionId);
          expect(settings(resumed)).toEqual(expectedRoot);
          const before = await runtime!.readNativeThreadSettings(threadId);
          const version = before.confirmed!.settings.settingsVersion!;
          expect(before.confirmed!.settings).toEqual({
            ...selectedSettings,
            approvalPolicy: expectedRoot.approvalPolicy,
            settingsVersion: version,
          });
          const at = second.messages.length;
          // Native deduplicates empty updates. Probe a field whose pre-probe
          // value was just verified by resume so personality/collaboration and
          // the remaining full snapshot can be observed without masking loss.
          const approvalPolicy =
            expectedRoot.approvalPolicy === "never" ? "on-request" : "never";
          await first.request("thread/settings/update", {
            threadId,
            approvalPolicy,
          });
          await vi.waitFor(
            () => {
              const event = second.messages
                .slice(at)
                .find((entry) => entry.method === "thread/settings/updated");
              expect(event).toBeDefined();
              expect(event!.params.threadSettings).toEqual({
                ...selectedSettings,
                approvalPolicy,
                settingsVersion: {
                  epoch: version.epoch,
                  revision: (BigInt(version.revision) + 1n).toString(),
                },
              });
              expect(
                runtime!.getNativeThreadSettings(threadId).confirmed?.settings,
              ).toEqual(event!.params.threadSettings);
            },
            { timeout: 5_000 },
          );
          expectedRoot = { ...expectedRoot, approvalPolicy };
        };
        const preserve = (generation: string) => ({
          ...input,
          runtime: runtime!,
          configuration: {
            ...configuration,
            intent: "preserve" as const,
            mcpServers: managedServers(generation),
          },
        });
        // The views keep old launch hints. Reusing preparation must retain native
        // settings selected since those hints were created.
        await coordinator.prepare(preserve("one"));
        await runtime.prepareExternalSync({ ...configuration, threadId });
        const observations = new ThreadObservationRegistry();
        const observationScope = {
          serverId: "server",
          ownerId: "owner",
          workerId: "worker",
          chatId: "chat",
          threadId,
          cwd: workspace,
          modelRouteId: model.routeId,
          providerId: runtimeProvider.id,
          providerKind: runtimeProvider.kind,
          providerAccountId: runtimeProvider.accountId,
          credentialHomeKey: runtimeProvider.credentialHomeKey,
        };
        observations.bind(observationScope, runtime);
        const logBeforeObservation = await readFile(log, "utf8");
        expect(
          await observations.sync(observationScope, async () => {
            throw new Error(
              "A bound custom-child runtime must not resolve another route or cold bootstrap.",
            );
          }),
        ).toMatchObject({ threadId, status: "idle", turns: [] });
        expect(await readFile(log, "utf8")).toBe(logBeforeObservation);
        expect(children).toHaveLength(1);
        await assertSelected();
        await invoke(second, "one");
        await coordinator.prepare(preserve("two"));
        await catalog(second);
        await invoke(second, "two");
        await assertSelected();
        await second.disconnect();
        coordinator = new ManagedSessionCoordinator(journal);
        expect(await coordinator.prepare(preserve("two"))).toEqual(prepared);
        second = await connect();
        await second.request("thread/resume", { threadId });
        await invoke(second, "two");
        await assertSelected();
        expect(children).toHaveLength(1);

        // Retire the actual worker-owned process, then recover its journal and
        // native durable thread with newer managed credentials and stale hints.
        await first.disconnect();
        await second.disconnect();
        await stopRuntime();
        inventoryUnavailable = true;
        runtime = createRuntime();
        const restartedEndpoint = await runtime.remoteEndpoint(
          model,
          runtimeProvider,
          configuration,
        );
        first = await connect(restartedEndpoint);
        expect(
          (await first.request("model/list", {})).data.map(
            (entry: JsonObject) => entry.model,
          ),
        ).toEqual(["gpt-5", "fixture-child"]);
        expect(loadInventory).toHaveBeenCalledTimes(2);
        expect(runtime.getManagedModelInventory()).toBeNull();
        expect((await first.request("thread/loaded/list", {})).data).toEqual(
          [],
        );
        coordinator = new ManagedSessionCoordinator(journal);
        expect(await coordinator.prepare(preserve("three"))).toEqual(prepared);
        const recoveredSettings =
          await runtime.readNativeThreadSettings(threadId);
        expect(
          recoveredSettings.confirmed!.settings.settingsVersion!.epoch,
        ).not.toBe(initialSettingsVersion.epoch);
        expect(recoveredSettings.confirmed!.settings.model).toBe(
          expectedRoot.model,
        );

        second = await connect(restartedEndpoint);
        const coldJoined = await first.request("thread/resume", { threadId });
        engineSessionId = coldJoined.thread.sessionId;
        expect(typeof engineSessionId).toBe("string");
        const coldPeerJoined = await second.request("thread/resume", {
          threadId,
        });
        expect(coldPeerJoined.thread.sessionId).toBe(engineSessionId);
        await catalog(second);
        await invoke(second, "three");
        await assertSelected();
        expect(children).toHaveLength(2);
        expect(
          (await first.request("thread/read", { threadId, includeTurns: true }))
            .thread.turns,
        ).toEqual([]);
        expect((await first.request("thread/loaded/list", {})).data).toEqual([
          threadId,
        ]);
        expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(
          configuredAccountConfig,
        );
        for (const file of await readdir(journal)) {
          const association = await readFile(path.join(journal, file), "utf8");
          expect(association).not.toContain("fixture-credential-");
          expect(association).not.toContain("synthetic-provider-key");
          expect(association).toContain(threadId);
        }
        expect(providerRequests).toEqual([]);
        expect(
          clients
            .flatMap((client) => client.messages)
            .filter((entry) => entry.method === "turn/started"),
        ).toEqual([]);
        expect(
          diagnostics.filter((entry) => entry.method === "turn/started"),
        ).toEqual([]);
        expect(inheritedInitializations(await readMcpLog())).toEqual([]);
        // Actual pinned config API: explicit defaults persist independently of
        // both attached views. No synthetic prompt or personal account is used.
        const nativeConfig = (
          method: string,
          params: Record<string, unknown>,
        ) => first.request(method, params);
        const defaultsBefore = await readNativeAccountDefaults(nativeConfig);
        const threadBeforeDefaults = (
          await runtime.readNativeThreadSettings(threadId)
        ).confirmed!.settings;
        const savedDefaults = await writeNativeAccountDefaults(
          nativeConfig,
          nativeAccountDefaultsParams({
            expectedVersion: defaultsBefore.version,
            values: {
              model: "gpt-5",
              model_reasoning_effort: "low",
              service_tier: "fast",
            },
          }),
          () => {},
        );
        expect(savedDefaults.verification).toBe("confirmed");
        expect(savedDefaults.snapshot?.stored).toMatchObject({
          model: "gpt-5",
          model_reasoning_effort: "low",
          service_tier: "fast",
        });
        expect(
          (await runtime.readNativeThreadSettings(threadId)).confirmed!
            .settings,
        ).toEqual(threadBeforeDefaults);
        expect(
          (
            await readNativeAccountDefaults((method, params) =>
              second.request(method, params),
            )
          ).version,
        ).toBe(savedDefaults.write!.version);
        await expect(
          writeNativeAccountDefaults(
            nativeConfig,
            nativeAccountDefaultsParams({
              expectedVersion: defaultsBefore.version,
              values: { model: "stale-overwrite" },
            }),
            () => {},
          ),
        ).rejects.toThrow(/modified|version|conflict/i);
        const clearedTier = await writeNativeAccountDefaults(
          nativeConfig,
          nativeAccountDefaultsParams({
            expectedVersion: savedDefaults.write!.version,
            values: { service_tier: null },
          }),
          () => {},
        );
        expect(clearedTier.verification).toBe("confirmed");
        expect(clearedTier.snapshot!.stored).not.toHaveProperty("service_tier");
        const competingDefaults = await Promise.allSettled(
          [first, second].map((client, index) =>
            writeNativeAccountDefaults(
              (method, params) => client.request(method, params),
              nativeAccountDefaultsParams({
                expectedVersion: clearedTier.write!.version,
                values: {
                  model_reasoning_effort: index === 0 ? "high" : "medium",
                },
              }),
              () => {},
            ),
          ),
        );
        expect(
          competingDefaults.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          competingDefaults.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        expect(
          (await runtime.readNativeThreadSettings(threadId)).confirmed!
            .settings,
        ).toEqual(threadBeforeDefaults);
        expect(providerRequests).toEqual([]);
      } catch (error) {
        bodyFailures.push(error);
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        const cleanup = async (task: () => Promise<unknown>) => {
          try {
            await task();
          } catch (error) {
            cleanupErrors.push(error);
          }
        };
        await Promise.all(
          clients.map((client) => cleanup(() => client.disconnect())),
        );
        await cleanup(stopRuntime);
        await cleanup(async () => {
          const recorded = await readMcpLog().catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            },
          );
          console.info("Native managed worker fixture evidence", {
            childStarts: children.length,
            modelRequests: providerRequests.length,
            inheritedMcpInitializations:
              inheritedInitializations(recorded).length,
          });
        });
        await cleanup(async () => {
          provider.closeAllConnections();
          await new Promise<void>((resolve) => provider.close(() => resolve()));
        });
        await cleanup(() =>
          rm(root, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          }),
        );
        if (cleanupErrors.length)
          throw new AggregateError(
            [...bodyFailures, ...cleanupErrors],
            "Native fixture cleanup failed",
          );
      }
    }, 90_000);
  },
);
