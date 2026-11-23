import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  cantripOsDesktopPlacement,
  cantripOsExecutionSchema,
  type CantripOsExecution,
} from "@cantrip/protocol";
import { cuaPreviewAuthoritySchema } from "@cantrip/protocol/computer-use-preview";
import type { CantripCuaService } from "../computer-use/service.js";
import { OsCuaServices } from "./computer-use.js";
import type { remoteControl, OsExecutorTransport } from "./connection.js";

function fixture() {
  const execution = cantripOsExecutionSchema.parse({
    kind: "cantrip-os",
    transport: { kind: "docker", container: "disposable-os" },
    scope: {
      ownerId: "owner",
      workerId: "worker",
      projectId: "project",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId: "cua-a",
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      projectSourceId: randomUUID(),
      worktreeId: randomUUID(),
      sourceKind: "folder",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/homes/cua-a",
      guestPath: "/homes/cua-a/checkouts/source",
      dependencyOverlays: [],
      mode: "linux-owned",
      linkedWorkerPath: null,
    },
  });
  const scope = execution.scope;
  const authority = cuaPreviewAuthoritySchema.parse({
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    placementId: scope.worktreeId,
    generation: 1,
    cantripAppAllowed: false,
    osPlacement: cantripOsDesktopPlacement(execution),
    profile: {
      selectedId: ":yolo",
      effectiveId: ":yolo",
      forcedByWorktreePolicy: false,
      usesDefault: false,
    },
  });
  let context = {
    instance_id: scope.guestInstanceId,
    generation: scope.runtimeGeneration,
    owner_id: "owner",
    worker_id: "worker",
    workspace_id: "cua-a",
    desktop_generation: "a".repeat(64),
    remote_generation: randomUUID(),
    uid: scope.uid,
    gid: scope.gid,
    home: scope.homeGuestPath,
    user: "ctw-cua-a",
    display: 100,
  };
  const services: {
    service: CantripCuaService;
    close: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const create = vi.fn((_command?: { command: string; args: string[] }) => {
    let closed = false;
    const close = vi.fn(async () => {
      closed = true;
    });
    const disconnect = vi.fn();
    const service = {
      status: () => ({ state: closed ? "closed" : "idle" }),
      close,
      disconnect,
      reconnect: vi.fn(),
      cancelChat: vi.fn(),
      cancelThread: vi.fn(),
    } as unknown as CantripCuaService;
    services.push({ service, close, disconnect });
    return service;
  });
  const host = create();
  create.mockClear();
  const control = vi.fn(
    async (_transport: OsExecutorTransport, args: string[]) =>
      args[0] === "open" ? context : { status: "closed" },
  );
  const placements = {
    resolve: vi.fn((): CantripOsExecution | undefined => execution),
  };
  const registry = new OsCuaServices({
    workerId: "worker",
    host,
    placements,
    control: control as typeof remoteControl,
    create,
  });
  return {
    registry,
    execution,
    authority,
    host,
    services,
    create,
    control,
    placements,
    context: () => context,
    change: (values: Partial<typeof context>) => {
      context = { ...context, ...values };
    },
  };
}
const active = () => new AbortController().signal;

describe("OS desktop service ownership", () => {
  it("pins a viewer to its observed desktop generation before native startup", async () => {
    const f = fixture();
    const generation = f.context().desktop_generation;
    const viewer = await f.registry.acquireExecution(
      "server",
      f.execution,
      active(),
      generation,
    );
    expect(viewer.desktopGeneration).toBe(generation);
    const open = f.control.mock.calls[0]![1];
    expect(
      JSON.parse(open[open.indexOf("--expect-placement") + 1]!),
    ).toMatchObject({ desktop_generation: generation });
    f.change({ desktop_generation: "b".repeat(64) });
    await expect(
      f.registry.acquireExecution("server", f.execution, active(), generation),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.services[1]!.close).not.toHaveBeenCalled();
    await viewer.release();
    await f.registry.close();
  });
  it("shares a Server-admitted viewer with the assigned agent and fences wrong Workers", async () => {
    const f = fixture();
    const viewer = await f.registry.acquireExecution(
      "server",
      f.execution,
      active(),
    );
    const agent = await f.registry.acquire(f.authority, active());
    expect(viewer.service).toBe(agent.service);
    expect(viewer.service).not.toBe(f.host);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(
      f.registry.acquireExecution(
        "server",
        { ...f.execution, scope: { ...f.execution.scope, workerId: "other" } },
        active(),
      ),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    await viewer.release();
    expect(f.services[1]!.close).not.toHaveBeenCalled();
    await agent.release();
    expect(f.services[1]!.close).toHaveBeenCalledTimes(1);
    await f.registry.close();
  });
  it("shares one connection across owned leases and closes only after the last release", async () => {
    const f = fixture();
    const first = await f.registry.acquire(f.authority, active());
    const second = await f.registry.acquire(
      { ...f.authority, chatId: "second-chat" },
      active(),
    );
    expect(first.service).toBe(second.service);
    expect(first.service).not.toBe(f.host);
    expect(f.create).toHaveBeenCalledTimes(1);
    const argv = f.create.mock.calls[0]![0] as unknown as { args: string[] };
    const connectionId = argv.args[argv.args.indexOf("--connection-id") + 1];
    const open = f.control.mock.calls[0]![1];
    expect(JSON.parse(open[open.indexOf("--expect-placement") + 1]!)).toEqual({
      instance_id: f.execution.scope.guestInstanceId,
      generation: f.execution.scope.runtimeGeneration,
      owner_id: "owner",
      worker_id: "worker",
      workspace_id: "cua-a",
      uid: 20000,
      gid: 20000,
      home: "/homes/cua-a",
    });
    await first.release();
    expect(f.services[1]!.close).not.toHaveBeenCalled();
    await second.release();
    expect(f.services[1]!.close).toHaveBeenCalledTimes(1);
    expect(f.control.mock.calls.at(-1)![1]).toEqual([
      "close",
      "cua-a",
      "--expect",
      JSON.stringify(f.context()),
      "--connection-id",
      connectionId,
    ]);
    await second.release();
    expect(f.services[1]!.close).toHaveBeenCalledTimes(1);
    await f.registry.close();
  });

  it("does not substitute Host when either side loses the Linux placement capture", async () => {
    const f = fixture();
    await expect(
      f.registry.acquire({ ...f.authority, osPlacement: undefined }, active()),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    f.placements.resolve.mockReturnValue(undefined);
    await expect(
      f.registry.acquire(f.authority, active()),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(f.control).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    const host = await f.registry.acquire(
      { ...f.authority, osPlacement: undefined },
      active(),
    );
    expect(host.service).toBe(f.host);
    await host.release();
    expect(f.services[0]!.close).not.toHaveBeenCalled();
    await f.registry.close();
  });

  it.each([
    "bindingGeneration",
    "attachmentGeneration",
    "runtimeGeneration",
    "guestWorkspaceId",
    "worktreeId",
  ] as const)(
    "rejects a mismatched canonical %s before opening a desktop",
    async (field) => {
      const f = fixture();
      const osPlacement = {
        ...f.authority.osPlacement!,
        [field]: field === "guestWorkspaceId" ? "other" : randomUUID(),
      };
      await expect(
        f.registry.acquire({ ...f.authority, osPlacement }, active()),
      ).rejects.toMatchObject({ code: "ownership-mismatch" });
      expect(f.control).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      await f.registry.close();
    },
  );

  it("rejects a misrouted actual guest response without creating a Host or guest helper", async () => {
    const f = fixture();
    f.change({ uid: 20001 });
    await expect(
      f.registry.acquire(f.authority, active()),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(f.create).not.toHaveBeenCalled();
    await f.registry.close();
  });

  it("pins older leases and keeps their late release from closing a replacement", async () => {
    const f = fixture();
    const first = await f.registry.acquire(f.authority, active());
    f.change({ desktop_generation: "b".repeat(64) });
    const second = await f.registry.acquire(f.authority, active());
    expect(second.service).not.toBe(first.service);
    expect(f.services[1]!.close).toHaveBeenCalled();
    const calls = f.control.mock.calls.length;
    await first.release();
    expect(f.control).toHaveBeenCalledTimes(calls);
    expect(f.services[2]!.close).not.toHaveBeenCalled();
    await second.release();
    expect(f.services[2]!.close).toHaveBeenCalledTimes(1);
    await f.registry.close();
  });

  it("fences in-flight metadata across disconnect and does not revive that acquisition", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    const ready = new Promise<unknown>((done) => {
      resolve = done;
    });
    f.control.mockImplementationOnce(async () => ready as never);
    const request = f.registry.acquire(f.authority, active());
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(1));
    f.registry.disconnect();
    f.registry.reconnect();
    resolve(f.context());
    await expect(request).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    const current = await f.registry.acquire(f.authority, active());
    expect(current.service).not.toBe(f.host);
    await current.release();
    await f.registry.close();
  });
});
