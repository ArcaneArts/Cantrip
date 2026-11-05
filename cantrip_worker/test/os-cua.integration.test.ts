import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  cantripOsDesktopPlacement,
  cantripOsExecutionSchema,
} from "@cantrip/protocol";
import { CuaAgentCoordinator } from "../src/computer-use/agent.js";
import { CuaAgentApprovalEvents } from "../src/computer-use/agent-approval-events.js";
import { CuaApprovalManager } from "../src/computer-use/approvals.js";
import { OsCuaServices } from "../src/os-executor/computer-use.js";
import { OsAgentPlacements } from "../src/os-executor/agent-placements.js";
import { CantripMcpBroker } from "../src/mcp/broker.js";
import { managedCuaMcpHttpServer } from "../src/mcp/managed.js";
import { parseCuaMcpResult } from "../src/mcp/cua-contract.js";
import { describe, expect, it } from "vitest";
import { CantripCuaService } from "../src/computer-use/service.js";
import {
  remoteCommand,
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";

const transport: OsExecutorTransport | null = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : null;

interface Desktop {
  instance_id: string;
  generation: string;
  owner_id: string;
  worker_id: string;
  workspace_id: string;
  desktop_generation: string;
  remote_generation: string;
  uid: number;
  gid: number;
  home: string;
  display: number;
}

describe.skipIf(!transport)(
  "actual packaged Linux CUA through the Worker service",
  () => {
    it("validates real capture, click, key and text receipts through the protected carrier", async () => {
      const context = await remoteControl<Desktop>(transport!, [
        "open",
        "cua-a",
      ]);
      const connectionId = randomUUID();
      const command = remoteCommand(transport!, [
        "connect",
        context.workspace_id,
        "--expect",
        JSON.stringify(context),
        "--connection-id",
        connectionId,
      ]);
      const service = new CantripCuaService({
        workerId: context.worker_id,
        binary: command.command,
        args: command.args,
      });
      const scope = {
        serverId: "os-cua-fixture",
        ownerId: context.owner_id,
        workerId: context.worker_id,
        chatId: "os-cua-fixture-chat",
        taskId: null,
        threadId: "os-cua-fixture-thread",
        turnId: "os-cua-fixture-turn",
      };
      try {
        const capabilities = await service.capabilities(scope);
        expect(capabilities.backend).toBe("linux-x11");
        const [target] = await service.targets(scope);
        expect(target.id).toBe(
          `x11-:${context.display}-${context.desktop_generation}`,
        );
        const reference = {
          targetId: target.id,
          targetGeneration: target.generation,
        };
        // The explicit guest display does not require a Host Cantrip-app grant.
        // Product permission/placement admission is covered by its own integration.
        expect(target.access).toMatchObject({ allowed: true });
        const session = await service.open(scope, reference);
        const id = session.binding.sessionId;
        const capture = await service.snapshot(scope, id, reference);
        expect(capture.payload.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        const click = await service.click(scope, id, reference, {
          x: 500,
          y: 500,
        });
        expect(click.input).toMatchObject({
          method: "coordinate",
          position: { x: 500, y: 500 },
          globalPosition: { x: 500, y: 500 },
        });
        const key = await service.perform(scope, id, reference, {
          kind: "key",
          key: "Escape",
          modifiers: [],
        });
        expect(key.input).toMatchObject({
          method: "background-key",
          activation: false,
          windowDelivery: "unverified",
        });
        const text = await service.perform(scope, id, reference, {
          kind: "text",
          text: "Cantrip",
        });
        expect(text.input).toMatchObject({
          method: "background-text",
          activation: false,
          outcome: "dispatched",
        });
        await service.writeClipboard(
          scope,
          id,
          reference,
          "Worker clipboard 日本語 café 🦀",
        );
        expect((await service.readClipboard(scope, id, reference)).text).toBe(
          "Worker clipboard 日本語 café 🦀",
        );
        const motion = await service.perform(scope, id, reference, {
          kind: "move",
          point: { x: 321, y: 234 },
        });
        expect(motion.input).toMatchObject({
          method: "background-move",
          position: { x: 321, y: 234 },
        });
        const resized = await service.resizeDesktop(
          scope,
          id,
          reference,
          1280,
          720,
        );
        expect(resized.target).toMatchObject({
          pixelWidth: 1280,
          pixelHeight: 720,
        });
        await service.resizeDesktop(scope, id, reference, 1440, 900);
        // These receipts prove dispatch/protocol compatibility. Actual xterm bytes
        // are checked by the separate native Linux and product acceptance tests.
      } finally {
        await service.close();
        await remoteControl(transport!, [
          "close",
          context.workspace_id,
          "--expect",
          JSON.stringify(context),
          "--connection-id",
          connectionId,
        ]);
      }
    }, 120_000);
    it("executes real Linux SDK capture/input through MCP, turn authorization and shared placement routing", async () => {
      const desktop = await remoteControl<Desktop>(transport!, [
        "open",
        "cua-a",
      ]);
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cantrip-os-cua-sdk-"),
      );
      const identity = {
        ownerId: desktop.owner_id,
        workerId: desktop.worker_id,
        serverId: "os-cua-sdk-fixture",
      };
      const chatId = randomUUID();
      const worktreeId = randomUUID();
      const execution = cantripOsExecutionSchema.parse({
        kind: "cantrip-os",
        transport,
        scope: {
          ownerId: identity.ownerId,
          workerId: identity.workerId,
          projectId: "os-cua-fixture-project",
          instanceId: randomUUID(),
          guestInstanceId: desktop.instance_id,
          attachmentGeneration: randomUUID(),
          runtimeGeneration: desktop.generation,
          bindingId: randomUUID(),
          bindingGeneration: randomUUID(),
          projectSourceId: randomUUID(),
          worktreeId,
          workspaceId: randomUUID(),
          guestWorkspaceId: "cua-a",
          uid: desktop.uid,
          gid: desktop.gid,
          homeGuestPath: desktop.home,
          guestPath: desktop.home + "/Documents",
          sourceKind: "folder",
          mode: "linux-owned",
          linkedWorkerPath: null,
          dependencyOverlays: [],
        },
      });
      const placements = new OsAgentPlacements(directory);
      placements.resolve({ ...identity, chatId }, execution);
      let hostStarts = 0;
      const host = new CantripCuaService({
        workerId: identity.workerId,
        launch: () => {
          hostStarts += 1;
          throw new Error("The Host helper must not start for an OS command");
        },
      });
      const services = new OsCuaServices({
        workerId: identity.workerId,
        host,
        placements,
      });
      const authority = {
        ...identity,
        chatId,
        projectId: "os-cua-fixture-project",
        contextKind: "project" as const,
        placementId: worktreeId,
        executionLaneId: "os-cua-fixture-lane",
        generation: 1,
        cantripAppAllowed: false,
        osPlacement: cantripOsDesktopPlacement(execution),
        profile: {
          selectedId: ":yolo",
          effectiveId: ":yolo",
          forcedByWorktreePolicy: false,
          usesDefault: false,
        },
      };
      const lifetime = new AbortController();
      const approvals = new CuaApprovalManager({
        workerId: identity.workerId,
        encryption: {
          ownerId: () => identity.ownerId,
          serverIdentity: () => identity.serverId,
          componentKey: () => ({
            key: new Uint8Array(32).fill(73),
            keyRevision: 1,
          }),
        },
      });
      const coordinator = new CuaAgentCoordinator({
        service: host,
        approvals,
        events: new CuaAgentApprovalEvents(),
        identity: () => identity,
        acquireService: (claims, signal) => services.acquire(claims, signal),
        authority: async () => authority,
      });
      // Deterministic admitted-turn fixture. A real-provider product turn remains
      // a separate acceptance requirement; native capture/input here are real.
      const unregister = coordinator.register({
        ...identity,
        initialAuthority: authority,
        chatId,
        projectId: authority.projectId,
        contextKind: "project",
        placementId: worktreeId,
        executionLaneId: authority.executionLaneId,
        taskId: null,
        rootThreadId: "native-sdk-thread",
        ownsThread: (id) => id === "native-sdk-thread",
        publish: async () => {},
        resolve: (input) =>
          input.threadId === "native-sdk-thread" &&
          input.turnId === "native-sdk-turn"
            ? {
                ...input,
                rootThreadId: "native-sdk-thread",
                rootTurnId: "native-sdk-turn",
                parentThreadId: null,
                signal: lifetime.signal,
              }
            : null,
      });
      const broker = new CantripMcpBroker({
        dataDirectory: directory,
        serverUrl: "https://example.invalid",
        token: "fixture-worker-token-never-sent-to-guest",
        workerId: identity.workerId,
      });
      broker.setComputerUseExecutor((...args) => coordinator.execute(...args));
      const client = new Client({ name: "actual-Linux-CUA-SDK", version: "1" });
      try {
        await broker.start();
        const binding = broker.createBinding({
          ownerId: identity.ownerId,
          workerId: identity.workerId,
          chatId,
          projectId: authority.projectId,
          contextKind: "project",
          worktreeId,
          rootKind: "folder-root",
          scratchRootId: null,
          executionLaneId: authority.executionLaneId,
          permissionProfileId: ":yolo",
          allowedOperations: ["context.get"],
          computerUse: true,
        });
        const config = managedCuaMcpHttpServer(binding.connection);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
          }),
        );
        const result = parseCuaMcpResult(
          await client.callTool({
            name: "js",
            arguments: {
              script:
                "const p = await cua.targets(); const t = p.targets[0]; await cua.attach({targetId:t.id,targetGeneration:t.generation}); await cua.click({x:500,y:500}); await cua.keyPress('Escape'); await cua.writeClipboard('Cantrip SDK 日本語 café 🦀'); const clipboard = await cua.readClipboard(); await cua.movePointer({x:321,y:234}); await cua.resizeDesktop(1280,720); await cua.snapshot(); await cua.resizeDesktop(1440,900); ({clipboard, session:(await cua.getState()).session})",
            },
            _meta: {
              threadId: "native-sdk-thread",
              "x-codex-turn-metadata": { turn_id: "native-sdk-turn" },
              itemId: "sdk-item",
              callId: "sdk-call",
            },
          }),
        );
        expect(
          result.isError,
          JSON.stringify(result.content.filter((item) => item.type === "text")),
        ).not.toBe(true);
        const text = result.content.find((item) => item.type === "text");
        if (text?.type !== "text")
          throw new Error("Missing native SDK metadata");
        expect(JSON.parse(text.text).value.clipboard).toBe(
          "Cantrip SDK 日本語 café 🦀",
        );
        expect(JSON.parse(text.text).value.session.target.id).toBe(
          `x11-:${desktop.display}-${desktop.desktop_generation}`,
        );
        const image = result.content.find((item) => item.type === "image");
        if (image?.type !== "image")
          throw new Error("Missing actual model image");
        expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect(hostStarts).toBe(0);
      } finally {
        await client.close();
        await broker.close();
        await unregister();
        await coordinator.close();
        approvals.close();
        await services.close();
        await rm(directory, { recursive: true, force: true });
      }
      const status = await remoteControl<{ connections: object }>(transport!, [
        "status",
      ]);
      expect(status.connections).toEqual({});
    }, 120_000);
  },
);
