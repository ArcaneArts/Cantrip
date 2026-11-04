import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGuestProcess } from "../src/os-executor/process.js";
import { CantripOsController } from "../src/os-executor/controller.js";
import { OsNativeEnvironment } from "../src/os-executor/native-environment.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import {
  CodexAppServer,
  type RunAgentTurnOptions,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY;
const enabled = Boolean(
  binary &&
  (process.env.CANTRIP_OS_TEST_CONTAINER ||
    process.env.CANTRIP_OS_TEST_TRANSPORT),
);
interface Tool {
  type: string;
  name: string;
  namespace?: string;
  parameters?: { properties?: Record<string, unknown> };
  tools?: Tool[];
}
function tools(items: Tool[], namespace?: string): Tool[] {
  return items.flatMap((tool) =>
    tool.type === "namespace"
      ? tools(tool.tools ?? [], tool.name)
      : [{ ...tool, namespace }],
  );
}

// The provider is deterministic. Tool execution, model loop, approvals, patching,
// process handling and filesystem access use the actual pinned native runtime.
describe.skipIf(!enabled)("native Cantrip agent Linux tools", () => {
  it("runs shell/read/search, native patch/write and artifact commands through the selected guest environment", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-linux-native-turn-"),
    );
    const workerId = "00000000-0000-4000-8000-000000000002",
      ownerId = "00000000-0000-4000-8000-000000000001";
    const controller = new CantripOsController(directory, workerId);
    const actual = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as { guestInstanceId: string; runtimeGeneration: string };
    const core = {
      ownerId,
      workerId,
      serverId: "native-turn-acceptance",
      instanceId: randomUUID(),
      guestInstanceId: actual.guestInstanceId,
      attachmentGeneration: randomUUID(),
      runtimeGeneration: actual.runtimeGeneration,
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: core,
      transport,
    });
    const guestWorkspaceId = `turn-${randomUUID().slice(0, 12)}`;
    const profile = (await controller.handle({
      type: "cantrip-os.workspaces.create",
      scope: core,
      transport,
      guestWorkspaceId,
      operationId: randomUUID(),
    })) as {
      state: string;
      receipt: {
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    expect(profile.state).toBe("ready");
    const sourceId = randomUUID();
    const scope = {
      ...core,
      ...profile.receipt.workspace,
      guestWorkspaceId,
      projectId: randomUUID(),
      projectSourceId: sourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      workspaceId: randomUUID(),
      sourceKind: "folder" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      guestPath: `${profile.receipt.workspace.homeGuestPath}/checkouts/${sourceId}`,
      dependencyOverlays: [],
    };
    const cancelMode = process.env.CANTRIP_OS_TEST_CANCEL === "1";
    const childCode =
      "import os,subprocess,time,json,pathlib;leaf=subprocess.Popen(['sleep','300']);p=pathlib.Path('cancel-child.json');p.write_text(json.dumps({'child':os.getpid(),'leaf':leaf.pid}));p.chmod(0o644);time.sleep(300)";
    const parentCode = `import os,sys,subprocess,time,json,pathlib
p=pathlib.Path('start-count');p.open('a').write('start\\n');p.chmod(0o644)
child=subprocess.Popen([sys.executable,'-c',${JSON.stringify(childCode)}],start_new_session=True)
p=pathlib.Path('cancel-parent.json');p.write_text(json.dumps({'parent':os.getpid(),'child':child.pid}));p.chmod(0o644)
time.sleep(300)`;
    const cancelCommand = `sudo -n python3 - <<'CANTRIP_CANCEL_FIXTURE'\n${parentCode}\nCANTRIP_CANCEL_FIXTURE`;
    const requests: Record<string, unknown>[] = [],
      activities: unknown[] = [],
      authenticatedRequests: boolean[] = [];
    let runtime: CodexAppServer | undefined,
      connection: OsExecutorConnection | undefined,
      providerError: Error | undefined,
      independentProcess: string | undefined;
    const provider = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        await writeFile(
          path.join(directory, "native-requests.json"),
          JSON.stringify(requests, null, 2),
        );
        authenticatedRequests.push(Boolean(request.headers.authorization));
        const offered = tools(body.tools ?? []);
        await writeFile(
          path.join(directory, "offered-tools.json"),
          JSON.stringify(offered, null, 2),
        );
        const step = requests.length;
        let item: Record<string, unknown>;
        if (step === 1 || step === 3) {
          const tool = offered.find((tool) =>
            tool.name.endsWith("exec_command"),
          );
          if (!tool)
            throw new Error(
              `Native exec tool missing: ${offered.map((t) => t.name).join(",")}`,
            );
          const command =
            step === 1
              ? 'python3 -c \'import os,json;print(json.dumps({"uid":os.getuid(),"cwd":os.getcwd()}))\';cat input.txt;rg seed input.txt'
              : 'python3 -c \'import os,json,pathlib;assert pathlib.Path("input.txt").read_text()=="patched in Linux\\n";assert pathlib.Path("written.txt").read_text()=="native patch write\\n";pathlib.Path("artifact.txt").write_text(json.dumps({"uid":os.getuid(),"cwd":os.getcwd(),"result":"guest artifact","has_provider_key":bool(os.getenv("CANTRIP_PROVIDER_API_KEY"))}))\'';
          item = {
            type: "function_call",
            call_id: `call-${step}`,
            name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            arguments: JSON.stringify({
              cmd: cancelMode ? cancelCommand : command,
              max_output_tokens: 2000,
              yield_time_ms: cancelMode ? 10000 : 1000,
            }),
          };
        } else if (step === 2) {
          const tool = offered.find((tool) =>
            tool.name.endsWith("apply_patch"),
          );
          if (!tool)
            throw new Error(
              `Native patch tool missing: ${offered.map((t) => t.name).join(",")}`,
            );
          const patch =
            "*** Begin Patch\n*** Update File: input.txt\n@@\n-seed line\n+patched in Linux\n*** Add File: written.txt\n+native patch write\n*** End Patch";
          item = {
            call_id: `call-${step}`,
            name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            ...(tool.type === "custom"
              ? { type: "custom_tool_call", input: patch }
              : {
                  type: "function_call",
                  arguments: JSON.stringify({
                    [Object.keys(tool.parameters?.properties ?? {})[0] ??
                    "patch"]: patch,
                  }),
                }),
          };
        } else
          item = {
            type: "message",
            role: "assistant",
            id: "final",
            content: [
              {
                type: "output_text",
                text: "Completed. [artifact](artifact.txt)",
              },
            ],
          };
        response.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "response.created", response: { id: `response-${step}` } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: `response-${step}`,
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ];
        response.end(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
        );
      } catch (error) {
        providerError = error as Error;
        response.writeHead(500);
        response.end("Fixture provider error");
      }
    });
    try {
      const provision = (await controller.handle({
        type: "cantrip-os.source.provision",
        scope,
        transport,
        operationId: randomUUID(),
        intent: { mode: "linux-owned", source: { kind: "folder" } },
      })) as { state: string };
      expect(provision.state).toBe("ready");
      const binding = await executorControl<OsExecutorBinding>(transport, [
        "open",
        guestWorkspaceId,
      ]);
      connection = new OsExecutorConnection(transport, binding);
      await connection.request("initialize", {
        clientName: "cantrip-native-turn-fixture",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      await connection.request("fs/writeFile", {
        path: guestFileUri(`${scope.guestPath}/input.txt`),
        dataBase64: Buffer.from("seed line\n").toString("base64"),
        sandbox: null,
      });
      const home = path.join(directory, "native-home"),
        environment = new OsNativeEnvironment(scope, transport, controller);
      await environment.prepare(home);
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\nfeatures.code_mode=false\nfeatures.unified_exec=true\n",
      );
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const model = {
        id: "fixture-model",
        routeId: "fixture-route",
        name: "gpt-5",
        reasoningEffort: "low" as const,
        catalog: {
          displayName: "Freeform Responses fixture",
          description: null,
          metadataSource: "zai" as const,
          contextWindow: 128000,
          inputModalities: ["text"],
          supportsTools: true,
          supportsParallelTools: false,
          supportsReasoning: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      };
      runtime = new CodexAppServer(
        binary!,
        path.join(directory, "native-data"),
        home,
        await discoverCodexRuntime(binary!, home),
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        null,
        environment,
      );
      const options: RunAgentTurnOptions = {
        cwd: scope.guestPath,
        threadId: null,
        model,
        provider: {
          id: "fixture-provider",
          name: "Local fixture",
          kind: "openai-compatible",
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          apiKey: "synthetic-key",
        },
        chatId: randomUUID(),
        clientMessageId: randomUUID(),
        captureProtectedDiagnostics: false,
        executionProfile: "ide",
        isPrimary: true,
        automationPaused: false,
        planMode: "default",
        policyContext: null,
        permissionProfileId:
          process.env.CANTRIP_OS_TEST_PERMISSION_PROFILE ?? ":yolo",
        prompt:
          "Read and search input.txt, patch its seed line, create written.txt, then execute Python to produce artifact.txt in this Linux source.",
        rootKind: "folder-root",
        skillNames: [],
        mcpServers: [],
        subagentDefaults: null,
        subagentProtocolVersion: undefined,
        worktreeMode: "pinned",
        worktreePolicy: "direct",
        onActivity: (activity) => {
          activities.push(activity);
        },
      };
      const read = async (name: string) =>
        Buffer.from(
          (
            await connection!.request<{ dataBase64: string }>("fs/readFile", {
              path: guestFileUri(`${scope.guestPath}/${name}`),
              sandbox: null,
            })
          ).dataBase64,
          "base64",
        ).toString();
      if (process.env.CANTRIP_OS_TEST_PERMISSION_PROFILE === ":read-only") {
        await expect(runtime.runTurn(options)).rejects.toThrow(
          /interrupted|permission|denied/i,
        );
        expect(await read("input.txt")).toBe("seed line\n");
        await expect(read("written.txt")).rejects.toThrow();
        await expect(read("artifact.txt")).rejects.toThrow();
        expect(requests).toHaveLength(2);
        return;
      }
      if (cancelMode) {
        independentProcess = randomUUID();
        await connection.request("process/start", {
          processId: independentProcess,
          argv: ["sleep", "300"],
          cwd: guestFileUri(scope.guestPath),
          env: {},
          tty: false,
          arg0: null,
          sandbox: null,
        });
        let threadId: string | null = null;
        options.onThreadLoaded = (value) => {
          threadId = value;
        };
        const running = runtime.runTurn(options);
        void running.catch(() => {});
        let pids: { parent: number; child: number; leaf: number } | undefined;
        await vi.waitFor(
          async () => {
            pids = {
              ...JSON.parse(await read("cancel-parent.json")),
              ...JSON.parse(await read("cancel-child.json")),
            };
            expect(pids!.leaf).toBeGreaterThan(0);
          },
          { timeout: 15000, interval: 100 },
        );
        expect(await runtime.interruptChat(options.chatId, threadId)).toEqual({
          interrupted: true,
        });
        await expect(running).rejects.toThrow(/interrupted/i);
        const ids = [pids!.parent, pids!.child, pids!.leaf];
        await vi.waitFor(
          async () => {
            const check = await runGuestProcess(
              connection!,
              [
                "python3",
                "-c",
                "import pathlib,json,sys;print(json.dumps([p for p in json.loads(sys.argv[1]) if pathlib.Path('/proc',str(p)).exists()]))",
                JSON.stringify(ids),
              ],
              scope.guestPath,
            );
            await writeFile(
              path.join(directory, "cancel-observation.json"),
              check.stdout,
            );
            if (JSON.parse(check.stdout).length) {
              const state = await runGuestProcess(
                connection!,
                [
                  "ps",
                  "-o",
                  "pid,ppid,pgid,user,stat,args",
                  "-p",
                  ids.join(","),
                ],
                scope.guestPath,
              );
              await writeFile(
                path.join(directory, "cancel-ps.txt"),
                state.stdout,
              );
            }
            expect(JSON.parse(check.stdout)).toEqual([]);
          },
          { timeout: 15000, interval: 100 },
        );
        expect((await read("start-count")).trim()).toBe("start");
        expect(requests).toHaveLength(1);
        expect(
          await connection.request("process/read", {
            processId: independentProcess,
            afterSeq: null,
            waitMs: 0,
            maxBytes: 1024,
          }),
        ).toMatchObject({ exited: false });
        await writeFile(
          path.join(directory, "native-cancellation-proof.json"),
          JSON.stringify(
            {
              scope,
              killedPids: ids,
              mutationCount: 1,
              independentProcessSurvived: true,
            },
            null,
            2,
          ),
        );
        return;
      }
      const result = await runtime.runTurn(options);
      const nativeConfig = await (
        runtime as unknown as {
          request(
            method: string,
            params: unknown,
          ): Promise<{ config: { features: Record<string, boolean> } }>;
        }
      ).request("config/read", { includeLayers: false });
      expect(nativeConfig.config.features).toMatchObject({
        computer_use: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
      });
      await writeFile(
        path.join(directory, "native-host-features-proof.json"),
        JSON.stringify(
          Object.fromEntries(
            [
              "computer_use",
              "browser_use",
              "browser_use_external",
              "in_app_browser",
            ].map((name) => [name, nativeConfig.config.features[name]]),
          ),
          null,
          2,
        ),
      );
      expect(providerError).toBeUndefined();
      expect(result.status).toBe("completed");
      expect(requests).toHaveLength(4);
      expect(authenticatedRequests.every(Boolean)).toBe(true);
      expect(await read("input.txt")).toBe("patched in Linux\n");
      expect(await read("written.txt")).toBe("native patch write\n");
      expect(JSON.parse(await read("artifact.txt"))).toEqual({
        uid: scope.uid,
        cwd: scope.guestPath,
        result: "guest artifact",
        has_provider_key: false,
      });
      expect(JSON.stringify(activities)).toContain("written.txt");
      expect(JSON.stringify(requests)).toContain("seed line");
      await writeFile(
        path.join(directory, "native-turn-proof.json"),
        JSON.stringify(
          { scope, result, activities, requestCount: requests.length },
          null,
          2,
        ),
      );
    } finally {
      runtime?.close();
      await connection?.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await executorControl(transport, ["close", guestWorkspaceId]);
    }
  }, 180_000);
});
