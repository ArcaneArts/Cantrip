import { readFileSync } from "node:fs";
import { probeX11 } from "./fixtures/os-x11-probe.js";
import { encryptSurfacePrivateState } from "@cantrip/crypto";
import {
  OsDesktopSession,
  prepareOsDesktop,
} from "../src/desktop/os-desktop.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
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
      let viewer: OsDesktopSession | null = null;
      try {
        await broker.start();
        const componentKey = new Uint8Array(32).fill(73);
        const surfaceId = randomUUID();
        const stateProtection = await encryptSurfacePrivateState({
          ownerId: identity.ownerId,
          context: {
            serverId: identity.serverId,
            resource: "remote-desktop-row",
            resourceId: surfaceId,
            operationId: null,
            recordKind: "remote-desktop-state",
          },
          keyRevision: 1,
          componentKey,
          content: {
            version: 1,
            classification: { recordKind: "remote-desktop-state" },
            revision: 1,
            target: { kind: "monitor", id: null, name: null },
          },
        });
        const frames: Uint8Array[] = [];
        const controls: { id: string; message: any }[] = [];
        const latest = (id: string, type: string) =>
          controls.findLast(
            (item) => item.id === id && item.message.type === type,
          )?.message;
        const encryption = {
          ownerId: () => identity.ownerId,
          status: () => ({ error: null }),
          componentKey: () => ({ key: componentKey.slice(), keyRevision: 1 }),
        } as unknown as WorkerEncryptionService;
        const prepared = await prepareOsDesktop(
          {
            type: "surface.desktop.os-prepare",
            serverId: identity.serverId,
            projectId: authority.projectId,
            osExecution: execution,
          },
          services,
          encryption,
          identity.workerId,
        );
        expect(prepared.desktopGeneration).toBe(desktop.desktop_generation);
        const viewerStartedAt = performance.now();
        let firstFrameMs: number | null = null;
        const scope = execution.scope;
        viewer = new OsDesktopSession(
          {
            type: "surface.attach",
            surfaceId,
            attachmentId: "viewer",
            projectId: authority.projectId,
            serverId: identity.serverId,
            configuration: {
              kind: "desktop",
              osSource: {
                bindingId: scope.bindingId,
                worktreeId: scope.worktreeId,
                bindingGeneration: scope.bindingGeneration,
                attachmentGeneration: scope.attachmentGeneration,
                runtimeGeneration: scope.runtimeGeneration,
                desktopGeneration: prepared.desktopGeneration,
              },
            },
            osExecution: execution,
            stateProtection,
            stateRevision: 1,
            stateResource: "remote-desktop-row",
            preferredTransport: "websocket",
            webrtc: null,
            viewport: { width: 800, height: 600, devicePixelRatio: 1 },
            desktopStream: { targetFps: 2, quality: "balanced" },
          },
          (_id, channel, payload) => {
            if (channel === "control" || channel === "clipboard")
              controls.push({
                id: _id,
                message: JSON.parse(new TextDecoder().decode(payload)),
              });
            if (channel === "frame") {
              firstFrameMs ??= performance.now() - viewerStartedAt;
              frames.push(payload);
            }
            return true;
          },
          services,
          encryption,
          identity.workerId,
        );
        process.stdout.write(
          "Linux viewer acceptance: opening assigned desktop\n",
        );
        await viewer.attach({
          id: "viewer",
          viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        });
        const frameDeadline = Date.now() + 20_000;
        while (!frames.length && Date.now() < frameDeadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        expect(frames.length).toBeGreaterThan(0);
        expect(Buffer.from(frames[0]!).subarray(0, 3)).toEqual(
          Buffer.from([255, 216, 255]),
        );
        process.stdout.write(
          `Linux viewer acceptance: first JPEG ${Number(firstFrameMs).toFixed(1)}ms, ${frames[0]!.byteLength} bytes\n`,
        );
        await viewer.attach({
          id: "second-viewer",
          viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        });
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
        process.stdout.write(
          "Linux viewer acceptance: concurrent agent input and capture completed\n",
        );
        await viewer.handleFrame(
          "viewer",
          "control",
          new TextEncoder().encode(
            JSON.stringify({
              type: "clipboard",
              operation: "paste-text",
              text: "Unowned viewer input must not dispatch",
            }),
          ),
        );
        const sendHuman = (id: string, message: unknown) =>
          viewer!.handleFrame(
            id,
            "control",
            new TextEncoder().encode(JSON.stringify(message)),
          );
        const agentLease = await services.acquire(authority, lifetime.signal);
        try {
          const agentScope = {
            ...identity,
            chatId,
            taskId: null,
            threadId: "native-sdk-thread",
            turnId: "native-sdk-turn",
          };
          const target = (await agentLease.service.targets(agentScope))[0]!;
          const reference = {
            targetId: target.id,
            targetGeneration: target.generation,
          };
          const native = await agentLease.service.open(agentScope, reference);
          const holding = agentLease.service
            .perform(agentScope, native.binding.sessionId, reference, {
              kind: "timeline",
              frames: [
                { atMs: 0, pointerDown: { x: 500, y: 500 } },
                { atMs: 150000, pointerUp: true },
              ],
            })
            .catch((error) => error);
          expect(
            (await probeX11(transport!, desktop.display, true)).mask & 256,
          ).toBe(256);
          await sendHuman("viewer", {
            type: "desktop-control",
            operation: "take",
          });
          expect(
            (await probeX11(transport!, desktop.display, false)).mask & 256,
          ).toBe(0);
          expect(await holding).toMatchObject({ code: "cancelled" });
          const control = latest("viewer", "desktop-control");
          expect(control).toMatchObject({ mode: "human", isController: true });
          const epoch = latest("viewer", "desktop-input").epoch;
          expect(typeof epoch).toBe("string");
          await sendHuman("viewer", {
            type: "clipboard",
            operation: "copy",
            inputEpoch: epoch,
            inputSequence: 1,
          });
          const clipboardDeadline = Date.now() + 20_000;
          while (
            !latest("viewer", "desktop-clipboard") &&
            Date.now() < clipboardDeadline
          )
            await new Promise((resolve) => setTimeout(resolve, 25));
          expect(latest("viewer", "desktop-clipboard")).toMatchObject({
            text: "Cantrip SDK 日本語 café 🦀",
          });
          await expect(agentLease.service.targets(agentScope)).rejects.toThrow(
            /human controls/,
          );
          const blocked = parseCuaMcpResult(
            await client.callTool({
              name: "js",
              arguments: { script: "await cua.targets()" },
              _meta: {
                threadId: "native-sdk-thread",
                "x-codex-turn-metadata": { turn_id: "native-sdk-turn" },
                itemId: "during-human-control",
                callId: "during-human-control",
              },
            }),
          );
          expect(blocked.isError).toBe(true);
          await sendHuman("second-viewer", {
            type: "desktop-control",
            operation: "take",
          });
          expect(latest("second-viewer", "desktop-control")).toMatchObject({
            mode: "human",
            isController: false,
          });
          await sendHuman("viewer", {
            type: "pointer",
            event: "down",
            x: 321,
            y: 234,
            button: "left",
            inputEpoch: epoch,
            inputSequence: 2,
          });
          const humanHeld = await probeX11(transport!, desktop.display, true);
          expect(humanHeld).toMatchObject({ x: 321, y: 234 });
          expect(humanHeld.mask & 256).toBe(256);
          await sendHuman("viewer", {
            type: "desktop-control",
            operation: "return",
            leaseId: randomUUID(),
          });
          expect(agentLease.service.control.owner).not.toBeNull();
          await sendHuman("viewer", {
            type: "desktop-control",
            operation: "return",
            leaseId: control.leaseId,
          });
          expect(
            (await probeX11(transport!, desktop.display, false)).mask & 256,
          ).toBe(0);
          expect(agentLease.service.control.owner).toBeNull();
          await sendHuman("viewer", {
            type: "pointer",
            event: "down",
            x: 900,
            y: 500,
            button: "left",
            inputEpoch: epoch,
            inputSequence: 3,
          });
          expect((await probeX11(transport!, desktop.display)).mask & 256).toBe(
            0,
          );
          const resumed = parseCuaMcpResult(
            await client.callTool({
              name: "js",
              arguments: {
                script:
                  "const t=(await cua.targets()).targets[0]; await cua.attach({targetId:t.id,targetGeneration:t.generation}); await cua.snapshot()",
              },
              _meta: {
                threadId: "native-sdk-thread",
                "x-codex-turn-metadata": { turn_id: "native-sdk-turn" },
                itemId: "after-human-return",
                callId: "after-human-return",
              },
            }),
          );
          expect(
            resumed.isError,
            JSON.stringify(
              resumed.content.filter((item) => item.type === "text"),
            ),
          ).not.toBe(true);
          process.stdout.write(
            "Linux takeover acceptance: actual agent hold released, exclusive human hold released on return, stale epoch rejected, same admitted turn resumed\n",
          );
        } finally {
          await agentLease.release();
        }
        await viewer.detach("viewer");
        await viewer.detach("second-viewer");
        // Detaching a viewer must not retire the agent's shared native service.
        const continued = parseCuaMcpResult(
          await client.callTool({
            name: "js",
            arguments: {
              script:
                "await cua.snapshot(); ({clipboard:await cua.readClipboard(),session:(await cua.getState()).session})",
            },
            _meta: {
              threadId: "native-sdk-thread",
              "x-codex-turn-metadata": { turn_id: "native-sdk-turn" },
              itemId: "sdk-after-viewer",
              callId: "sdk-after-viewer",
            },
          }),
        );
        expect(continued.isError).not.toBe(true);
        process.stdout.write(
          "Linux viewer acceptance: agent continued after last viewer detached\n",
        );
        const continuedText = continued.content.find(
          (item) => item.type === "text",
        );
        expect(
          continuedText?.type === "text" &&
            JSON.parse(continuedText.text).value.clipboard,
        ).toBe("Cantrip SDK 日本語 café 🦀");
        await viewer.attach({
          id: "after-agent",
          viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        });
        await unregister();
        const beforeAgentStopped = frames.length;
        const continuedDeadline = Date.now() + 20_000;
        while (
          frames.length === beforeAgentStopped &&
          Date.now() < continuedDeadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        expect(frames.length).toBeGreaterThan(beforeAgentStopped);
        process.stdout.write(
          "Linux viewer acceptance: viewer continued after agent retirement\n",
        );
        await sendHuman("after-agent", {
          type: "desktop-control",
          operation: "take",
        });
        const lastEpoch = latest("after-agent", "desktop-input").epoch;
        await sendHuman("after-agent", {
          type: "pointer",
          event: "down",
          x: 250,
          y: 200,
          button: "left",
          inputEpoch: lastEpoch,
          inputSequence: 1,
        });
        expect(
          (await probeX11(transport!, desktop.display, true)).mask & 256,
        ).toBe(256);
        viewer.suspend();
        expect(
          (await probeX11(transport!, desktop.display, false)).mask & 256,
        ).toBe(0);
        viewer.resume();
        await sendHuman("after-agent", {
          type: "desktop-control",
          operation: "take",
        });
        const renewedEpoch = latest("after-agent", "desktop-input").epoch;
        expect(renewedEpoch).not.toBe(lastEpoch);
        await sendHuman("after-agent", {
          type: "pointer",
          event: "down",
          x: 250,
          y: 200,
          button: "left",
          inputEpoch: renewedEpoch,
          inputSequence: 1,
        });
        expect(
          (await probeX11(transport!, desktop.display, true)).mask & 256,
        ).toBe(256);
        await viewer.detach("after-agent");
        expect(
          (await probeX11(transport!, desktop.display, false)).mask & 256,
        ).toBe(0);
        process.stdout.write(
          "Linux takeover acceptance: viewer disconnect released actual human held input\n",
        );
      } finally {
        await viewer?.close();
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
