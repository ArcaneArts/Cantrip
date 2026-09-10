import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServer,
  codexModelProviderName,
} from "../src/codex/app-server.js";
import { nativeRuntimeHandoffStateSchema } from "@cantrip/protocol";
import { ManagedRuntimeHandoffJournal } from "../src/codex/managed-runtime-handoff-journal.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)("native imported session preparation", () => {
  it("selects the destination while preserving imported settings and initializing managed MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-import-prepare-"));
    const cwd = path.join(root, "workspace");
    const sourceHome = path.join(root, "source");
    const targetHome = path.join(root, "target");
    const mcpPath = path.join(root, "fixture.mjs");
    const mcpLog = path.join(root, "mcp.log");
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(500).end("Preparation must not request inference.");
    });
    const runtimes: {
      runtime: CodexAppServer;
      child?: ChildProcessWithoutNullStreams;
      closed?: Promise<unknown>;
    }[] = [];
    try {
      await Promise.all([mkdir(cwd), mkdir(sourceHome), mkdir(targetHome)]);
      await writeFile(
        path.join(sourceHome, "config.toml"),
        'features.plugins=false\nservice_tier="priority"\nmodel_reasoning_effort="low"\n',
      );
      await writeFile(
        path.join(targetHome, "config.toml"),
        'features.plugins=false\nmodel_reasoning_effort="high"\n',
      );
      await writeFile(
        mcpPath,
        `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.id === undefined) continue;
  appendFileSync(process.env.FIXTURE_LOG, input.method + '\\n');
  const result = input.method === 'initialize'
    ? { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stage-fixture', version: '1' } }
    : input.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Harmless fixture', inputSchema: { type: 'object', properties: {} } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }) + '\\n');
}
`,
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const compatibility = await discoverCodexRuntime(
        binary!,
        path.join(root, "probe"),
      );
      const createRuntime = (home: string) => {
        const entry: (typeof runtimes)[number] = { runtime: undefined! };
        entry.runtime = new CodexAppServer(
          binary!,
          path.join(home, "runtime"),
          home,
          compatibility,
          undefined,
          undefined,
          undefined,
          (file, args, options) => {
            const child = spawn(file, args, {
              ...options,
              env: { ...options.env, HOME: root },
              stdio: "pipe",
            });
            entry.child = child;
            entry.closed = once(child, "close");
            return child;
          },
          [],
        );
        runtimes.push(entry);
        return entry.runtime;
      };
      const source = createRuntime(sourceHome);
      const destination = createRuntime(targetHome);
      const provider = {
        id: "source-provider",
        name: "Source fixture",
        kind: "openai" as const,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "fixture-not-a-real-key",
      };
      const model = {
        id: "source-model",
        routeId: "source-route",
        name: "gpt-5",
        reasoningEffort: "low" as const,
      };
      const common = {
        cwd,
        permissionProfileId: ":workspace",
        executionProfile: "ide" as const,
        subagentDefaults: { model: { ...model, name: "gpt-5-mini" }, provider },
        canonicalHistory: true,
      };
      const initial = await source.prepareManagedThread({
        ...common,
        model,
        provider,
        threadId: null,
        intent: "configure",
        planMode: "plan",
        mcpServers: [],
      });
      const original = (await source.readNativeThreadSettings(initial.threadId))
        .confirmed!.settings;
      expect(original.collaborationMode.mode).toBe("plan");
      const transferId = randomUUID();
      const scope = {
        serverId: "fixture-server",
        ownerId: "fixture-owner",
        workerId: "fixture-worker",
      };
      const state = nativeRuntimeHandoffStateSchema.parse({
        operationId: transferId,
        chatId: "fixture-chat",
        workerId: scope.workerId,
        phase: "preparing",
        source: {
          bindingId: "fixture-source-binding",
          chatId: "fixture-chat",
          workerId: scope.workerId,
          threadId: initial.threadId,
          contextKind: "project",
          projectId: "fixture-project",
          placementId: "fixture-placement",
          modelRouteId: model.routeId,
          providerAccountId: null,
          runtimeGeneration: source.transportGeneration!,
          nativeEpoch: "fixture-source-epoch",
        },
        targetModelRouteId: "destination-route",
        targetProviderAccountId: null,
        prepared: null,
        errorCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const journal = new ManagedRuntimeHandoffJournal(root, scope);
      const plan = await journal.prepare(state, async () => ({
        sourceHome,
        expectedLastTurnId:
          (await source.readNativeHistory(initial.threadId)).thread.turns.at(-1)
            ?.id ?? null,
        previousOperationId: null,
      }));
      let exports = 0;
      await expect(
        journal.export(plan, async (input) => {
          exports++;
          await source.exportManagedHistory(input);
          throw new Error("fixture lost native export response");
        }),
      ).rejects.toThrow("fixture lost native export response");
      // Reconstruct the controller after the native export committed but before
      // its receipt was journaled. It must read that artifact, not export again.
      const restartedJournal = new ManagedRuntimeHandoffJournal(root, scope);
      const recoveredPlan = await restartedJournal.prepare(state, async () => {
        throw new Error("Must retain the original export boundary");
      });
      const exported = await restartedJournal.export(
        recoveredPlan,
        async (input) => {
          exports++;
          return source.exportManagedHistory(input);
        },
      );
      expect(exports).toBe(1);
      expect(
        await restartedJournal.export(recoveredPlan, async () => {
          throw new Error("Must reuse acknowledged immutable artifact");
        }),
      ).toEqual(exported);
      const targetProvider = {
        ...provider,
        id: "destination-provider",
        name: "Destination fixture",
      };
      const targetModel = {
        ...model,
        id: "destination-model",
        routeId: "destination-route",
        name: "gpt-5.1",
        reasoningEffort: null,
      };
      const options = {
        ...common,
        provider: targetProvider,
        model: targetModel,
        subagentDefaults: null,
        permissionProfileId: ":read-only",
        planMode: "default" as const,
        transfer: {
          threadId: initial.threadId,
          transferId,
          path: exported.path,
        },
        mcpServers: [
          {
            name: "stage_fixture",
            transport: "stdio" as const,
            command: process.execPath,
            args: [mcpPath],
            environment: { FIXTURE_LOG: mcpLog },
            enabled: true,
          },
        ],
      };
      expect(
        await Promise.all([
          destination.prepareImportedManagedThread(options),
          destination.prepareImportedManagedThread(options),
        ]),
      ).toEqual([initial, initial]);
      const current = (
        await destination.readNativeThreadSettings(initial.threadId)
      ).confirmed!.settings;
      expect(current.model).toBe(targetModel.name);
      expect(current.modelProvider).toBe(
        codexModelProviderName(targetProvider),
      );
      for (const key of [
        "approvalPolicy",
        "approvalsReviewer",
        "sandboxPolicy",
        "activePermissionProfile",
        "serviceTier",
        "effort",
        "multiAgentMode",
        "multiAgentEnabled",
        "subagentModel",
        "subagentReasoningEffort",
        "personality",
      ] as const) {
        expect(current[key], key).toEqual(original[key]);
      }
      expect(current.collaborationMode.mode).toBe(
        original.collaborationMode.mode,
      );
      expect(current.collaborationMode.settings.model).toBe(targetModel.name);
      await expect
        .poll(
          async () =>
            (
              await destination.readCustomizationInventory({
                cwd,
                model: targetModel,
                provider: targetProvider,
                threadId: initial.threadId,
              })
            ).mcpServers,
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "stage_fixture" }),
          ]),
        );
      const log = await readFile(mcpLog, "utf8");
      expect(log).toContain("initialize");
      expect(log).toContain("tools/list");
      expect(
        (await source.readNativeThreadSettings(initial.threadId)).confirmed!
          .settings,
      ).toEqual(original);
      expect(
        (await destination.readNativeHistory(initial.threadId)).thread.turns,
      ).toEqual([]);
      expect(requests).toEqual([]);
      const changedArtifact = JSON.parse(await readFile(exported.path, "utf8"));
      changedArtifact.metadata.title = "fixture artifact corruption";
      await writeFile(exported.path, JSON.stringify(changedArtifact));
      await expect(
        restartedJournal.export(recoveredPlan, async () => {
          throw new Error("Must never replace a committed artifact");
        }),
      ).rejects.toThrow("Committed handoff artifact changed");
      await rm(exported.path);
      await expect(
        restartedJournal.export(recoveredPlan, async () => {
          throw new Error("Must never recreate a missing committed artifact");
        }),
      ).rejects.toThrow("Committed handoff export is missing");
    } finally {
      for (const entry of runtimes) {
        const force = setTimeout(() => entry.child?.kill("SIGKILL"), 5000);
        entry.runtime.close();
        await entry.closed;
        clearTimeout(force);
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
