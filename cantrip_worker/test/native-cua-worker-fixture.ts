import path from "node:path";
import type { NativeCommandAdmissionResult } from "@cantrip/protocol";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import type { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import type { CodexAppServer } from "../src/codex/app-server.js";
import { CuaAgentCoordinator } from "../src/computer-use/agent.js";
import { CuaAgentApprovalEvents } from "../src/computer-use/agent-approval-events.js";
import { CuaApprovalManager } from "../src/computer-use/approvals.js";
import { requestComputerUseAuthority } from "../src/computer-use/authority-client.js";
import type { CuaActivity } from "../src/computer-use/activity.js";
import { CantripCuaService } from "../src/computer-use/service.js";
import { CantripMcpBroker } from "../src/mcp/broker.js";
import { managedCuaMcpServer } from "../src/mcp/managed.js";

/** Real native metadata, broker, per-operation HTTP authority and Rust fake backend.
 * The only fake desktop is the compiled helper's explicitly selected backend. */
export async function createNativeCuaWorkerFixture(input: {
  authority: Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>;
  runtime: CodexAppServer;
  directory: string;
}) {
  const { authority: server, runtime } = input;
  const identity = {
    ownerId: server.ownerId,
    serverId: server.serverId,
    workerId: server.workerId,
  };
  const serverUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const service = new CantripCuaService({
    workerId: server.workerId,
    binary: process.env.CANTRIP_CUA_TEST_BINARY!,
    args: ["--backend", "fake"],
  });
  const events = new CuaAgentApprovalEvents();
  const approvals = new CuaApprovalManager({
    workerId: server.workerId,
    encryption: {
      ownerId: () => server.ownerId,
      serverIdentity: () => server.serverId,
      componentKey: () => ({
        key: new Uint8Array(32).fill(73),
        keyRevision: 1,
      }),
    },
    onTerminal: (event) => events.terminal(event),
  });
  const coordinator = new CuaAgentCoordinator({
    identity: () => identity,
    service,
    approvals,
    events,
    authority: (binding, signal) =>
      requestComputerUseAuthority({
        binding,
        signal,
        serverUrl,
        token: server.token,
      }),
  });
  const calls: Array<{
    args: Parameters<CuaAgentCoordinator["execute"]>;
    result?: CallToolResult;
    error?: unknown;
    elapsedMs?: number;
  }> = [];
  const activities: CuaActivity[] = [];
  const broker = new CantripMcpBroker({
    dataDirectory: input.directory,
    serverUrl,
    token: server.token,
    workerId: server.workerId,
  });
  broker.setComputerUseExecutor(async (...args) => {
    const call: (typeof calls)[number] = { args };
    calls.push(call);
    const started = performance.now();
    try {
      return (call.result = await coordinator.execute(...args));
    } catch (error) {
      call.error = error;
      throw error;
    } finally {
      call.elapsedMs = performance.now() - started;
    }
  });
  await broker.start();
  const claims = {
    ownerId: server.ownerId,
    workerId: server.workerId,
    chatId: server.chatId,
    projectId: server.projectId,
    contextKind: "project" as const,
    worktreeId: server.worktreeId,
    rootKind: server.context.rootKind!,
    scratchRootId: null,
    permissionProfileId: ":yolo",
    allowedOperations: ["context.get"] as ["context.get"],
    computerUse: true,
  };
  const attachment = broker.createSession(claims);
  const servers = [
    managedCuaMcpServer(
      {
        command: process.execPath,
        arguments: [
          "--import",
          import.meta.resolve("tsx"),
          path.resolve("src/mcp/cua-stdio.ts"),
        ],
      },
      attachment.connectionPath,
      attachment.connection.bindingId,
    ),
  ];
  const releases = new Set<() => Promise<void>>();
  return {
    servers,
    calls,
    activities,
    activate(grant: NativeCommandAdmissionResult, threadId: string) {
      expect(grant.computerUseAuthority).toBeTruthy();
      const active = broker.createBinding({
        ...claims,
        executionLaneId: grant.receipt.executionLaneId!,
      });
      expect(active.connectionPath).toBe(attachment.connectionPath);
      const unregister = coordinator.register({
        ...identity,
        initialAuthority: grant.computerUseAuthority!,
        chatId: server.chatId,
        projectId: server.projectId,
        contextKind: "project",
        placementId: server.placementId,
        executionLaneId: grant.receipt.executionLaneId!,
        taskId: null,
        rootThreadId: threadId,
        ownsThread: (id) => runtime.ownsComputerUseThread(threadId, id),
        resolve: (context) => runtime.resolveComputerUseExecution(context),
        publish: async () => {
          throw new Error(
            "The isolated YOLO fixture must not request user permission.",
          );
        },
        publishActivity: (activity) => {
          activities.push(activity);
        },
      });
      const release = async () => {
        broker.deactivateBinding(
          active.connection.bindingId,
          grant.receipt.executionLaneId!,
        );
        await unregister();
        releases.delete(release);
      };
      releases.add(release);
      return release;
    },
    assertRetired(index: number) {
      const [binding, request, id] = calls[index]!.args;
      expect(() =>
        coordinator.execute(binding, request, id, new AbortController().signal),
      ).toThrow();
    },
    async close() {
      for (const release of releases) await release();
      await broker.close();
      await coordinator.close();
      approvals.close();
      await service.close();
    },
  };
}
