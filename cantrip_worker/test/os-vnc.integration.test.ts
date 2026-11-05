import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { OsCuaServices } from "../src/os-executor/computer-use.js";
import { OsTunnelServices } from "../src/os-executor/tunnel-services.js";
import {
  CantripCuaService,
  type CuaServiceLease,
} from "../src/computer-use/service.js";
import {
  remoteControl,
  remoteCommand,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import {
  protectedOsTunnel,
  serverId,
  type Descriptor,
} from "./fixtures/os-protected-tunnel.js";
import { probeX11 } from "./fixtures/os-x11-probe.js";
import { RfbClient } from "./fixtures/rfb-client.js";

const transport: OsExecutorTransport | undefined = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : undefined;

describe.skipIf(!transport)("actual controlled CantripOS VNC", () => {
  it("captures real pixels, pauses agent input and releases physical VNC holds before returning control", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vnc-control-"),
    );
    let cua: OsCuaServices | undefined, tunnels: OsTunnelServices | undefined;
    let agent: CuaServiceLease | undefined, other: CuaServiceLease | undefined;
    const lifetime = new AbortController();
    const hostLaunch = vi.fn(() => {
      throw new Error("A Host CUA helper must never launch.");
    });
    try {
      await remoteControl(transport!, ["open", "cua-a"]);
      await remoteControl(transport!, ["open", "cua-b"]);
      const descriptor = await remoteControl<Descriptor>(transport!, [
        "service-info",
        "cua-a",
        "--service",
        '{"kind":"vnc"}',
      ]);
      const b = await remoteControl<Descriptor>(transport!, [
        "service-info",
        "cua-b",
        "--service",
        '{"kind":"vnc"}',
      ]);
      const fixture = await protectedOsTunnel(
        transport!,
        directory,
        descriptor,
        { kind: "worker-os-vnc" },
      );
      cua = new OsCuaServices({
        workerId: descriptor.worker_id,
        host: new CantripCuaService({
          workerId: descriptor.worker_id,
          launch: hostLaunch,
        }),
        placements: { resolve: () => undefined },
      });
      agent = await cua.acquireExecution(
        serverId,
        fixture.prepared.osExecution,
        lifetime.signal,
        descriptor.desktop_generation,
      );
      const scope = {
        serverId,
        ownerId: descriptor.owner_id,
        workerId: descriptor.worker_id,
        chatId: randomUUID(),
        taskId: null,
        threadId: "vnc-fixture-thread",
        turnId: "vnc-fixture-turn",
      };
      const target = (await agent.service.targets(scope))[0]!;
      expect(target.id).toBe(
        `x11-:${descriptor.display}-${descriptor.desktop_generation}`,
      );
      const reference = {
        targetId: target.id,
        targetGeneration: target.generation,
      };
      const session = await agent.service.open(scope, reference);
      const holding = agent.service
        .perform(scope, session.binding.sessionId, reference, {
          kind: "timeline",
          frames: [
            { atMs: 0, pointerDown: { x: 500, y: 500 } },
            { atMs: 150000, pointerUp: true },
          ],
        })
        .catch((error) => error);
      expect(
        (await probeX11(transport!, descriptor.display!, true)).mask & 256,
      ).toBe(256);
      other = await cua.acquireExecution(
        serverId,
        {
          ...fixture.prepared.osExecution,
          scope: {
            ...fixture.scope,
            workspaceId: randomUUID(),
            guestWorkspaceId: "cua-b",
            uid: b.uid,
            gid: b.gid,
            homeGuestPath: b.home,
            guestPath: b.home,
          },
        },
        lifetime.signal,
        b.desktop_generation,
      );
      tunnels = new OsTunnelServices(
        fixture.worker,
        descriptor.worker_id,
        () => cua!,
      );
      await tunnels.prepare(fixture.prepared);
      tunnels.activate(fixture.grant, fixture.session);
      const stream = await tunnels.open(
        fixture.attachmentId,
        fixture.tunnelId,
        fixture.record,
        fixture.content,
      );
      expect(await holding).toBeInstanceOf(Error);
      expect(
        (await probeX11(transport!, descriptor.display!, false)).mask & 256,
      ).toBe(0);
      expect(agent.service.control.owner).toMatch(/^vnc:/u);
      await expect(agent.service.targets(scope)).rejects.toThrow(
        /human controls/u,
      );
      await expect(
        agent.service.takeControl("a-second-viewer"),
      ).rejects.toMatchObject({ code: "ownership-mismatch" });
      await expect(
        tunnels.open(
          fixture.attachmentId,
          fixture.tunnelId,
          fixture.record,
          fixture.content,
        ),
      ).rejects.toMatchObject({ code: "ownership-mismatch" });
      expect(
        (await other.service.targets({ ...scope, chatId: randomUUID() }))[0]!
          .id,
      ).toBe(`x11-:${b.display}-${b.desktop_generation}`);
      const rfb = new RfbClient(stream),
        display = await rfb.initialize();
      expect(display.width).toBeGreaterThanOrEqual(800);
      expect(display.height).toBeGreaterThanOrEqual(600);
      expect(
        await rfb.rawFrame(display.width, display.height, display.bitsPerPixel),
      ).toBeGreaterThanOrEqual(display.width * display.height);
      rfb.key(65505, true);
      rfb.pointer(100, 100, 1);
      const held = await probeX11(transport!, descriptor.display!, true);
      expect(held.mask & 256).toBe(256);
      expect(held.shift).toBe(true);
      const unaffected = await probeX11(transport!, b.display!);
      expect(unaffected.mask & 256).toBe(0);
      expect(unaffected.shift).toBe(false);
      await tunnels.revoke(fixture.attachmentId, fixture.grantId);
      expect(agent.service.control.owner).toBeNull();
      const released = await probeX11(transport!, descriptor.display!, false);
      expect(released.mask & 256).toBe(0);
      expect(released.shift).toBe(false);
      expect(() =>
        agent!.service.state(scope, session.binding.sessionId),
      ).toThrow();
      const fresh = (await agent.service.targets(scope))[0]!;
      const current = await agent.service.open(scope, {
        targetId: fresh.id,
        targetGeneration: fresh.generation,
      });
      expect(
        (
          await agent.service.snapshot(scope, current.binding.sessionId, {
            targetId: fresh.id,
            targetGeneration: fresh.generation,
          })
        ).payload.subarray(0, 8),
      ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(hostLaunch).not.toHaveBeenCalled();
    } finally {
      lifetime.abort();
      await tunnels?.disconnect();
      await other?.release();
      await agent?.release();
      await cua?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
  it("fences an old VNC controller after an actual remote-manager replacement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vnc-replacement-"),
    );
    let cua: OsCuaServices | undefined, tunnels: OsTunnelServices | undefined;
    let agent: CuaServiceLease | undefined,
      replacement: CuaServiceLease | undefined;
    const lifetime = new AbortController();
    try {
      await remoteControl(transport!, ["open", "cua-a"]);
      const descriptor = await remoteControl<Descriptor>(transport!, [
        "service-info",
        "cua-a",
        "--service",
        '{"kind":"vnc"}',
      ]);
      const fixture = await protectedOsTunnel(
        transport!,
        directory,
        descriptor,
        { kind: "worker-os-vnc" },
      );
      const host = new CantripCuaService({
        workerId: descriptor.worker_id,
        launch: () => {
          throw new Error("No Host fallback permitted");
        },
      });
      cua = new OsCuaServices({
        workerId: descriptor.worker_id,
        host,
        placements: { resolve: () => undefined },
      });
      agent = await cua.acquireExecution(
        serverId,
        fixture.prepared.osExecution,
        lifetime.signal,
        descriptor.desktop_generation,
      );
      tunnels = new OsTunnelServices(
        fixture.worker,
        descriptor.worker_id,
        () => cua!,
      );
      await tunnels.prepare(fixture.prepared);
      tunnels.activate(fixture.grant, fixture.session);
      const stream = await tunnels.open(
        fixture.attachmentId,
        fixture.tunnelId,
        fixture.record,
        fixture.content,
      );
      const rfb = new RfbClient(stream);
      await rfb.initialize();
      rfb.key(65505, true);
      rfb.pointer(100, 100, 1);
      const held = await probeX11(transport!, descriptor.display!, true);
      expect(held.shift).toBe(true);
      expect(held.mask & 256).toBe(256);
      const restart = remoteCommand(transport!, ["service", "restart"]);
      await promisify(execFile)(restart.command, restart.args, {
        timeout: 90_000,
      });
      stream.destroy();
      await tunnels.revoke(fixture.attachmentId, fixture.grantId);
      expect(agent.service.status().state).toBe("closed");
      expect(agent.service.control.owner).toBeNull();
      const released = await probeX11(transport!, descriptor.display!, false);
      expect(released.shift).toBe(false);
      expect(released.mask & 256).toBe(0);
      await expect(
        tunnels.open(
          fixture.attachmentId,
          fixture.tunnelId,
          fixture.record,
          fixture.content,
        ),
      ).rejects.toThrow(/canonical grant/u);
      replacement = await cua.acquireExecution(
        serverId,
        fixture.prepared.osExecution,
        lifetime.signal,
        descriptor.desktop_generation,
      );
      const scope = {
        serverId,
        ownerId: descriptor.owner_id,
        workerId: descriptor.worker_id,
        chatId: randomUUID(),
        taskId: null,
        threadId: "vnc-replacement",
        turnId: "vnc-replacement-turn",
      };
      expect((await replacement.service.targets(scope))[0]!.id).toBe(
        `x11-:${descriptor.display}-${descriptor.desktop_generation}`,
      );
    } finally {
      lifetime.abort();
      await tunnels?.disconnect();
      await replacement?.release();
      await agent?.release();
      await cua?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
