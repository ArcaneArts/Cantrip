import { createHash, randomUUID } from "node:crypto";
import {
  decryptEndpointContentPayload,
  decryptInteractionRequestContent,
  encryptEndpointContentPayload,
  encryptInteractionResponseContent,
  openComputerUseResult,
  protectComputerUseRequest,
} from "@cantrip/crypto";
import {
  agentInteractionRequestPayloadSchema,
  type EncryptedAgentInteractionRequestCreate,
  type WorkerComputerUseApprovalResponseCommand,
  type WorkerComputerUseCommand,
} from "@cantrip/protocol";
import {
  CUA_REQUIRED_OPERATIONS,
  type ComputerUseAction,
  type ComputerUseChunkEvent,
  type CuaCapabilities,
  type CuaScope,
  type CuaSession,
} from "@cantrip/protocol/computer-use";
import type {
  CuaPreviewAuthority,
  CuaPreviewLease,
} from "@cantrip/protocol/computer-use-preview";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CuaApprovalManager } from "./approvals.js";
import {
  CuaPreviewCoordinator,
  type CuaPreviewEvent,
  type CuaPreviewCoordinatorOptions,
} from "./preview.js";
import { CantripCuaService, CuaServiceError } from "./service.js";
import { launchCuaTransport } from "./transport.js";

const key = new Uint8Array(32).fill(61);
const target = { targetId: "fake-monitor", targetGeneration: 1 };
const authority: CuaPreviewAuthority = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  chatId: "chat",
  projectId: null,
  contextKind: "standalone",
  placementId: "placement-a",
  generation: 1,
  profile: {
    selectedId: ":default",
    effectiveId: ":default",
    forcedByWorktreePolicy: false,
    usesDefault: true,
  },
};
const capabilities: CuaCapabilities = {
  protocolVersion: 1,
  runtimeVersion: "fixture",
  backend: "fake",
  capture: true,
  nativeInput: false,
  javascript: false,
  cursorAppearanceVersion: 1,
  operations: [...CUA_REQUIRED_OPERATIONS],
  maxSessions: 16,
  maxImageBytes: 16 * 1024 * 1024,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sE8AAAAASUVORK5CYII=",
  "base64",
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(scope: CuaScope): CuaSession {
  const { serverId: _server, ownerId: _owner, ...binding } = scope;
  return {
    binding: { ...binding, sessionId: "fixture-session" },
    target: {
      id: target.targetId,
      generation: 1,
      kind: "monitor",
      title: "private fixture screen",
      application: null,
      processId: null,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      pixelWidth: 1,
      pixelHeight: 1,
      scaleFactor: 1,
      focused: false,
      minimized: false,
    },
    cursor: {
      appearance: {
        version: 1,
        style: "arrow",
        color: "#FF0055",
        size: 24,
        label: "Agent",
        trail: false,
        visible: true,
      },
      position: { x: 0, y: 0 },
      trailPoints: [],
      updatedAtMs: 1,
      revision: 1,
    },
    observationRevision: 1,
  };
}

function fixture(
  actualBinary?: string,
  publishActivity?: CuaPreviewCoordinatorOptions["publishActivity"],
) {
  const encryption = {
    ownerId: vi.fn(() => "owner"),
    serverIdentity: vi.fn(() => "server"),
    componentKey: vi.fn(() => ({ key: key.slice(), keyRevision: 1 })),
  };
  const launch = vi.fn<typeof launchCuaTransport>(
    actualBinary
      ? launchCuaTransport
      : () => {
          throw new Error(
            "No native process is permitted in this unit fixture.",
          );
        },
  );
  const service = new CantripCuaService({
    workerId: "worker",
    binary: actualBinary ?? "/synthetic/cantrip-cua",
    args: ["--backend", "fake"],
    launch,
  });
  const approvals = new CuaApprovalManager({ workerId: "worker", encryption });
  const coordinator = new CuaPreviewCoordinator({
    workerId: "worker",
    service,
    approvals,
    encryption,
    publishActivity,
  });
  const cancelChat = vi.spyOn(service, "cancelChat");
  const cancelScope = vi.spyOn(service, "cancelScope");
  const authorize = vi.spyOn(approvals, "authorize");
  cleanups.push(async () => {
    coordinator.close();
    approvals.close();
    await service.close();
  });
  return {
    coordinator,
    approvals,
    service,
    encryption,
    launch,
    cancelChat,
    cancelScope,
    authorize,
  };
}

function stubCapture(service: CantripCuaService) {
  const open = vi
    .spyOn(service, "open")
    .mockImplementation(async (scope) => session(scope));
  const snapshot = vi
    .spyOn(service, "snapshot")
    .mockImplementation(async (scope) => ({
      session: session(scope),
      image: {
        mediaType: "image/png",
        width: 1,
        height: 1,
        byteCount: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        cursorIncluded: true,
      },
      payload: Buffer.from(png),
    }));
  return { open, snapshot };
}

async function command(
  action: ComputerUseAction,
  lease: CuaPreviewLease,
  current = authority,
): Promise<WorkerComputerUseCommand> {
  const context = {
    serverId: current.serverId,
    workerId: current.workerId,
    chatId: current.chatId,
    operationId: randomUUID(),
    operation: action.operation,
    previewLeaseId: lease.leaseId,
  };
  return {
    type: "computer-use.operation",
    serverId: current.serverId,
    chatId: current.chatId,
    executionLaneId: null,
    preview: { leaseId: lease.leaseId, authority: structuredClone(current) },
    request: await protectComputerUseRequest({
      context,
      request: action,
      seal: (context, plaintext) =>
        encryptEndpointContentPayload({
          ownerId: "owner",
          context,
          plaintext,
          componentKey: key,
          keyRevision: 1,
        }),
    }),
  };
}

async function execute(
  f: ReturnType<typeof fixture>,
  action: ComputerUseAction,
  lease: CuaPreviewLease,
  current = authority,
) {
  const request = await command(action, lease, current);
  const events: CuaPreviewEvent[] = [];
  const response = await f.coordinator.execute(request, async (event) => {
    events.push(event);
  });
  const opened = await openComputerUseResult({
    context: {
      serverId: current.serverId,
      workerId: current.workerId,
      chatId: current.chatId,
      operationId: request.request.operationId,
      operation: action.operation,
      previewLeaseId: lease.leaseId,
    },
    opaque: response,
    chunks: events.filter(
      (event): event is ComputerUseChunkEvent =>
        event.type === "computer-use.snapshot.chunk",
    ),
    open: (context, opaque) =>
      decryptEndpointContentPayload({
        ownerId: "owner",
        context,
        opaque,
        componentKey: key,
        keyRevision: 1,
      }),
  });
  return { ...opened, events, request, response };
}

function approval(events: CuaPreviewEvent[]) {
  const event = events.find(
    (event) => event.type === "computer-use.approval.request",
  );
  if (!event || event.type !== "computer-use.approval.request")
    throw new Error("Expected a durable approval request.");
  return event.request;
}

async function answer(
  request: EncryptedAgentInteractionRequestCreate,
  current = authority,
): Promise<WorkerComputerUseApprovalResponseCommand> {
  const opened = await decryptInteractionRequestContent({
    ownerId: "owner",
    requestKey: request.requestKey,
    keyRevision: 1,
    componentKey: key,
    encrypted: request.protectedPayload,
    publicClassification: request.classification,
  });
  const payload = agentInteractionRequestPayloadSchema.parse(opened.payload);
  if (payload.kind !== "permissions")
    throw new Error("Expected permission content.");
  const classification = { kind: "permissions" as const };
  return {
    type: "computer-use.approval.respond",
    ownerId: "owner",
    chatId: request.provenance.chatId!,
    executionLaneId: null,
    requestKey: request.requestKey,
    previewAuthority: structuredClone(current),
    response: {
      classification,
      protectedResponse: await encryptInteractionResponseContent({
        ownerId: "owner",
        requestKey: request.requestKey,
        keyRevision: 1,
        componentKey: key,
        content: {
          version: 1,
          classification,
          response: {
            kind: "permissions",
            permissions: payload.requestedPermissions,
            scope: "session",
            strictAutoReview: false,
          },
        },
      }),
    },
  };
}

function stop(f: ReturnType<typeof fixture>, lease: CuaPreviewLease) {
  return f.coordinator.stop({
    ownerId: "owner",
    serverId: "server",
    chatId: lease.chatId,
    leaseId: lease.leaseId,
  });
}

describe("worker-owned preview authority", () => {
  it("constructs, opens, shares an observer lease, and stops without starting a native helper", () => {
    const f = fixture();
    expect(f.coordinator.status()).toEqual({ previews: 0, closed: false });
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
    const lease = f.coordinator.open(authority);
    const observer = f.coordinator.open(structuredClone(authority));
    expect(observer).toEqual(lease);
    expect(observer).not.toBe(lease);
    observer.leaseId = randomUUID();
    expect(f.coordinator.open(authority)).toEqual(lease);
    expect(stop(f, lease)).toEqual({ closed: true });
    expect(stop(f, lease)).toEqual({ closed: true });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
    expect(f.service.status().sessions).toBe(0);
  });

  it("keeps preview task, thread, turn, and lane genuinely null", async () => {
    const f = fixture();
    const nativeCapabilities = vi
      .spyOn(f.service, "capabilities")
      .mockResolvedValue(capabilities);
    const lease = f.coordinator.open(authority);
    const result = await execute(f, { operation: "capabilities.get" }, lease);
    expect(result.result.status).toBe("ok");
    expect(nativeCapabilities.mock.calls[0]?.[0]).toEqual({
      ownerId: "owner",
      serverId: "server",
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: null,
      turnId: null,
    });
    expect(f.authorize.mock.calls[0]?.[0].context).toMatchObject({
      executionLaneId: null,
      previewLeaseId: lease.leaseId,
    });
    expect(result.events).toEqual([]);
  });

  it("rejects old authority and old packets without revoking a newer valid lease", async () => {
    const f = fixture();
    const a = f.coordinator.open(authority);
    const oldCommand = await command({ operation: "targets.list" }, a);
    const next = { ...authority, generation: 2, placementId: "placement-b" };
    const b = f.coordinator.open(next);
    await expect(
      f.coordinator.execute(oldCommand, async () => {}),
    ).rejects.toMatchObject({ code: "execution-unavailable" });
    expect(() => f.coordinator.open(authority)).toThrow();
    const stalePacket = await command(
      { operation: "targets.list" },
      b,
      authority,
    );
    await expect(
      f.coordinator.execute(stalePacket, async () => {}),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(f.coordinator.open(next)).toEqual(b);
    expect(f.coordinator.status().previews).toBe(1);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each([
    { placementId: "changed-without-generation" },
    { projectId: "project" },
    { contextKind: "project" as const },
    { profile: { ...authority.profile, selectedId: ":yolo" } },
    { profile: { ...authority.profile, effectiveId: ":read-only" } },
    { profile: { ...authority.profile, forcedByWorktreePolicy: true } },
    { profile: { ...authority.profile, usesDefault: false } },
  ])(
    "rejects placement/profile mutation without a generation change: %j",
    async (mutation) => {
      const f = fixture();
      const lease = f.coordinator.open(authority);
      expect(() => f.coordinator.open({ ...authority, ...mutation })).toThrow();
      const packet = await command({ operation: "targets.list" }, lease, {
        ...authority,
        ...mutation,
      });
      await expect(
        f.coordinator.execute(packet, async () => {}),
      ).rejects.toMatchObject({ code: "ownership-mismatch" });
      expect(f.launch).not.toHaveBeenCalled();
    },
  );

  it.each(["ownerId", "serverId", "workerId", "chatId"] as const)(
    "rejects foreign %s without native work",
    async (field) => {
      const f = fixture();
      const lease = f.coordinator.open(authority);
      const foreign = { ...authority, [field]: "foreign" };
      if (field !== "chatId")
        expect(() => f.coordinator.open(foreign)).toThrow();
      await expect(
        f.coordinator.execute(
          await command({ operation: "targets.list" }, lease, foreign),
          async () => {},
        ),
      ).rejects.toThrow();
      expect(f.coordinator.open(authority)).toEqual(lease);
      expect(f.launch).not.toHaveBeenCalled();
    },
  );

  it("rejects lane relabeling and encrypted-request relabeling onto a new preview", async () => {
    const f = fixture();
    const a = f.coordinator.open(authority);
    const packet = await command({ operation: "targets.list" }, a);
    await expect(
      f.coordinator.execute(
        { ...packet, executionLaneId: "invented-lane" },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    const next = { ...authority, generation: 2 };
    const b = f.coordinator.open(next);
    await expect(
      f.coordinator.execute(
        { ...packet, preview: { leaseId: b.leaseId, authority: next } },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    const events: CuaPreviewEvent[] = [];
    const response = await f.coordinator.execute(
      {
        ...packet,
        request: { ...packet.request, previewLeaseId: b.leaseId },
        preview: { leaseId: b.leaseId, authority: next },
      },
      async (event) => {
        events.push(event);
      },
    );
    const opened = await openComputerUseResult({
      context: {
        serverId: "server",
        workerId: "worker",
        chatId: "chat",
        operationId: packet.request.operationId,
        operation: "targets.list",
        previewLeaseId: b.leaseId,
      },
      opaque: response,
      chunks: [],
      open: (context, opaque) =>
        decryptEndpointContentPayload({
          ownerId: "owner",
          context,
          opaque,
          componentKey: key,
          keyRevision: 1,
        }),
    });
    expect(opened.result.status).toBe("error");
    expect(events).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("bounds previews to 32 while sharing identical observers and freeing stopped capacity", () => {
    const f = fixture();
    const leases = Array.from({ length: 32 }, (_, index) =>
      f.coordinator.open({ ...authority, chatId: `chat-${index}` }),
    );
    expect(f.coordinator.open({ ...authority, chatId: "chat-0" })).toEqual(
      leases[0],
    );
    expect(() =>
      f.coordinator.open({ ...authority, chatId: "chat-32" }),
    ).toThrow();
    stop(f, leases[0]!);
    expect(f.coordinator.open({ ...authority, chatId: "chat-32" }).chatId).toBe(
      "chat-32",
    );
    expect(f.coordinator.status().previews).toBe(32);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("revokes matching chat, project, and inherited default contexts without touching other previews", () => {
    const f = fixture();
    const standalone = f.coordinator.open(authority);
    const projectAuthority = {
      ...authority,
      chatId: "project-chat",
      projectId: "project",
      contextKind: "project" as const,
    };
    const project = f.coordinator.open(projectAuthority);
    const explicitAuthority = {
      ...authority,
      chatId: "explicit-chat",
      profile: { ...authority.profile, usesDefault: false },
    };
    const explicit = f.coordinator.open(explicitAuthority);
    expect(
      f.coordinator.revoke({
        ownerId: "owner",
        serverId: "server",
        scope: { kind: "inherited-default", contextKind: "standalone" },
      }),
    ).toEqual({ closed: true });
    expect(f.coordinator.open(explicitAuthority)).toEqual(explicit);
    expect(f.coordinator.open(projectAuthority)).toEqual(project);
    expect(f.coordinator.open(authority).leaseId).not.toBe(standalone.leaseId);
    expect(
      f.coordinator.revoke({
        ownerId: "owner",
        serverId: "server",
        scope: { kind: "project", projectId: "project" },
      }),
    ).toEqual({ closed: true });
    expect(f.coordinator.open(projectAuthority).leaseId).not.toBe(
      project.leaseId,
    );
    expect(
      f.coordinator.revoke({
        ownerId: "owner",
        serverId: "server",
        scope: { kind: "chat", chatId: "explicit-chat" },
      }),
    ).toEqual({ closed: true });
    expect(f.coordinator.open(explicitAuthority).leaseId).not.toBe(
      explicit.leaseId,
    );
  });

  it("disconnect and shutdown revoke leases without native replay, and shutdown rejects reopening", async () => {
    const f = fixture();
    const first = f.coordinator.open(authority);
    const packet = await command({ operation: "targets.list" }, first);
    f.coordinator.disconnect();
    expect(f.coordinator.status().previews).toBe(0);
    await expect(
      f.coordinator.execute(packet, async () => {}),
    ).rejects.toThrow();
    const next = f.coordinator.open(authority);
    expect(next.leaseId).not.toBe(first.leaseId);
    f.coordinator.close();
    f.coordinator.close();
    expect(() => f.coordinator.open(authority)).toThrow();
    expect(stop(f, next)).toEqual({ closed: true });
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "invalid-packet"] as const)(
    "ordinary preview %s cleanup leaves same-chat agent approvals alive",
    async (kind) => {
      const f = fixture();
      const lease = f.coordinator.open(authority);
      const previewRequest = approval(
        (await execute(f, { operation: "targets.list" }, lease)).events,
      );
      const agentContext = {
        ...f.authorize.mock.calls[0]![0].context,
        previewLeaseId: undefined,
        signal: new AbortController().signal,
        executionLaneId: "agent-lane",
        scope: {
          ...f.authorize.mock.calls[0]![0].context.scope,
          taskId: "task",
          threadId: "thread",
          turnId: "turn",
        },
      };
      const agent = await f.approvals.authorize({
        context: agentContext,
        operation: "targets.list",
      });
      if (agent.status !== "approval-required")
        throw new Error("Expected approval");
      if (kind === "disconnect") f.coordinator.disconnect();
      else
        await expect(
          f.coordinator.execute(
            await command({ operation: "targets.list" }, lease, {
              ...authority,
              placementId: "invalid-change-without-generation",
            }),
            async () => {},
          ),
        ).rejects.toMatchObject({ code: "ownership-mismatch" });
      expect(
        f.approvals.contextForResponse(previewRequest.requestKey),
      ).toBeNull();
      expect(
        f.approvals.contextForResponse(agent.request.requestKey)?.signal,
      ).toBe(agentContext.signal);
      expect(f.approvals.status().pending).toBe(1);
      expect(f.cancelChat).not.toHaveBeenCalled();
      expect(f.cancelScope).toHaveBeenCalledWith({
        ...agentContext.scope,
        taskId: null,
        threadId: null,
        turnId: null,
      });
      // A stale Stop for the released preview cannot terminate another owner.
      expect(stop(f, lease)).toEqual({ closed: true });
      expect(f.approvals.status().pending).toBe(1);
      expect(f.cancelChat).not.toHaveBeenCalled();
    },
  );

  it.each(["stop", "revocation", "placement", "interrupt"] as const)(
    "%s intentionally revokes chat-wide authority, unlike ordinary preview cleanup",
    async (kind) => {
      const f = fixture();
      const lease = f.coordinator.open(authority);
      await execute(f, { operation: "targets.list" }, lease);
      const context = f.authorize.mock.calls[0]![0].context;
      await f.approvals.authorize({
        context: {
          ...context,
          signal: new AbortController().signal,
          previewLeaseId: undefined,
          scope: { ...context.scope, threadId: "agent", turnId: "turn" },
        },
        operation: "targets.list",
      });
      expect(f.approvals.status().pending).toBe(2);
      if (kind === "stop") stop(f, lease);
      if (kind === "revocation")
        f.coordinator.revoke({
          ownerId: "owner",
          serverId: "server",
          scope: { kind: "chat", chatId: "chat" },
        });
      if (kind === "placement")
        f.coordinator.open({
          ...authority,
          generation: 2,
          placementId: "new-placement",
        });
      if (kind === "interrupt") f.coordinator.cancelChat("chat");
      expect(f.approvals.status().pending).toBe(0);
      expect(f.cancelChat).toHaveBeenCalledExactlyOnceWith("chat");
    },
  );
});

describe("one native session per shared preview lease", () => {
  const selected: CuaPreviewAuthority = {
    ...authority,
    profile: {
      ...authority.profile,
      selectedId: ":yolo",
      effectiveId: ":yolo",
    },
  };
  const openAction = { operation: "session.open", ...target } as const;

  it("clears captured bytes before a held activity publication and releases Stop before audit failure", async () => {
    const entered = deferred();
    const publication = deferred();
    const publish = vi.fn<
      NonNullable<CuaPreviewCoordinatorOptions["publishActivity"]>
    >(async () => {
      entered.resolve();
      await publication.promise;
      throw new Error("private encryption failure");
    });
    const f = fixture(undefined, publish);
    const native = stubCapture(f.service);
    const lease = f.coordinator.open(selected, "task");
    const pending = execute(
      f,
      {
        operation: "observation.snapshot",
        sessionId: "fixture-session",
        ...target,
      },
      lease,
      selected,
    );
    const failure = expect(pending).rejects.toThrow(
      "Protected computer-use activity could not be published.",
    );
    await entered.promise;
    const captured = await native.snapshot.mock.results[0]!.value;
    expect(captured.payload.every((byte: number) => byte === 0)).toBe(true);
    expect(publish.mock.calls[0]![0].binding).toMatchObject({
      taskId: "chat",
      threadId: null,
      turnId: null,
    });
    const stopped = f.coordinator.stop(
      { ...authority, leaseId: lease.leaseId, operationId: randomUUID() },
      async () => {},
    );
    expect(f.cancelChat).toHaveBeenCalledExactlyOnceWith("chat");
    publication.resolve();
    await failure;
    expect(await stopped).toEqual({
      closed: true,
      activityPublicationFailed: true,
    });
  });

  function shared() {
    const f = fixture();
    const native = stubCapture(f.service);
    const attach = vi
      .spyOn(f.service, "attach")
      .mockImplementation(async (scope, id, next) => {
        const value = session(scope);
        value.binding.sessionId = id;
        value.target!.id = next.targetId;
        value.target!.generation = next.targetGeneration;
        value.cursor.appearance.label = "Shared cursor";
        return value;
      });
    return { ...f, native, attach, lease: f.coordinator.open(selected) };
  }

  it("reuses one native session across repeated observers and target changes", async () => {
    const f = shared();
    for (let observer = 0; observer < 20; observer += 1) {
      const lease = f.coordinator.open(structuredClone(selected));
      expect(lease).toEqual(f.lease);
      const opened = await execute(f, openAction, lease, selected);
      expect(opened.result).toMatchObject({
        status: "ok",
        data: { session: { binding: { sessionId: "fixture-session" } } },
      });
    }
    const switched = await execute(
      f,
      { ...openAction, targetId: "fake-window" },
      f.lease,
      selected,
    );
    expect(switched.result).toMatchObject({
      status: "ok",
      data: {
        session: {
          binding: {
            sessionId: "fixture-session",
            workerId: "worker",
            chatId: "chat",
            taskId: null,
            threadId: null,
            turnId: null,
          },
          target: { id: "fake-window" },
          cursor: { appearance: { label: "Shared cursor" } },
        },
      },
    });
    expect(f.native.open).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(20);
    expect(f.attach.mock.lastCall?.[0]).toMatchObject({
      ownerId: "owner",
      serverId: "server",
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: null,
      turnId: null,
    });
  });

  it("serializes concurrent opens without allocating a second session", async () => {
    const f = shared();
    const entered = deferred();
    const release = deferred();
    const authorized = deferred();
    let authorizations = 0;
    f.authorize.mockImplementation(async () => {
      if (++authorizations === 2) authorized.resolve();
      return { status: "allowed" };
    });
    f.native.open.mockImplementation(async (scope) => {
      entered.resolve();
      await release.promise;
      return session(scope);
    });
    const first = execute(f, openAction, f.lease, selected);
    await entered.promise;
    const second = execute(f, openAction, f.lease, selected);
    await authorized.promise;
    release.resolve();
    const opened = await Promise.all([first, second]);
    expect(opened.map((entry) => entry.result.status)).toEqual(["ok", "ok"]);
    expect(f.native.open).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(1);
  });

  it("Stop cancels an in-flight open and its queued observer without restoring the lease", async () => {
    const f = shared();
    const entered = deferred();
    const release = deferred();
    f.native.open.mockImplementation(async (scope) => {
      entered.resolve();
      await release.promise;
      return session(scope);
    });
    const first = execute(f, openAction, f.lease, selected);
    await entered.promise;
    const secondPacket = await command(openAction, f.lease, selected);
    const second = f.coordinator.execute(secondPacket, async () => {});
    expect(stop(f, f.lease)).toEqual({ closed: true });
    release.resolve();
    expect((await first).result).toMatchObject({
      status: "error",
      code: "cancelled",
    });
    await second;
    expect(f.coordinator.status().previews).toBe(0);
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.native.open).toHaveBeenCalledTimes(1);
    const next = f.coordinator.open(selected);
    expect(next.leaseId).not.toBe(f.lease.leaseId);
    expect((await execute(f, openAction, next, selected)).result.status).toBe(
      "ok",
    );
    expect(f.native.open).toHaveBeenCalledTimes(2);
  });

  it("surfaces a lost cached session instead of silently replacing it", async () => {
    const f = shared();
    await execute(f, openAction, f.lease, selected);
    f.attach.mockRejectedValue(new CuaServiceError("session-not-found"));
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(
        (await execute(f, openAction, f.lease, selected)).result,
      ).toMatchObject({ status: "error", code: "session-not-found" });
    expect(f.native.open).toHaveBeenCalledTimes(1);
    stop(f, f.lease);
    const fresh = f.coordinator.open(selected);
    expect((await execute(f, openAction, fresh, selected)).result.status).toBe(
      "ok",
    );
    expect(f.native.open).toHaveBeenCalledTimes(2);
  });

  it("a rejected initial open does not cache an unusable native handle", async () => {
    const f = shared();
    f.native.open.mockRejectedValueOnce(new CuaServiceError("stale-target"));
    expect(
      (await execute(f, openAction, f.lease, selected)).result,
    ).toMatchObject({ status: "error", code: "stale-target" });
    expect(
      (await execute(f, openAction, f.lease, selected)).result.status,
    ).toBe("ok");
    expect(f.native.open).toHaveBeenCalledTimes(2);
    expect(f.attach).not.toHaveBeenCalled();
  });
});

describe("preview approvals use the existing encrypted interaction path", () => {
  it("waits for durable approval publication before returning the operation result", async () => {
    const f = fixture();
    const lease = f.coordinator.open(authority);
    const started = deferred();
    const publication = deferred();
    const order: string[] = [];
    const packet = await command({ operation: "targets.list" }, lease);
    const execution = f.coordinator
      .execute(packet, async (event) => {
        expect(event.type).toBe("computer-use.approval.request");
        started.resolve();
        await publication.promise;
        order.push("published");
      })
      .then((response) => {
        order.push("result");
        return response;
      });
    await started.promise;
    await Promise.resolve();
    expect(order).toEqual([]);
    publication.resolve();
    await execution;
    expect(order).toEqual(["published", "result"]);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("publishes a protected durable request before returning approval-required and executes only after an explicit retry", async () => {
    const f = fixture();
    const native = stubCapture(f.service);
    const lease = f.coordinator.open(authority);
    const action = {
      operation: "observation.snapshot",
      sessionId: "fixture-session",
      ...target,
    } as const;
    const initial = await execute(f, action, lease);
    expect(initial.result).toMatchObject({
      status: "error",
      code: "approval-required",
    });
    expect(initial.payload).toBeNull();
    const request = approval(initial.events);
    expect(request.provenance).toMatchObject({
      owner: "computer-use",
      chatId: "chat",
      workerId: "worker",
      threadId: null,
      turnId: null,
      itemId: null,
      executionLaneId: null,
    });
    expect(JSON.stringify(request)).not.toContain("targetId");
    expect(native.snapshot).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    await expect(f.coordinator.answer(await answer(request))).resolves.toEqual({
      accepted: true,
    });
    expect(native.snapshot).not.toHaveBeenCalled();
    const retried = await execute(f, action, lease);
    expect(retried.result.status).toBe("ok");
    expect(retried.payload).toEqual(new Uint8Array(png));
    retried.payload?.fill(0);
    expect(retried.events.map((event) => event.type)).toEqual([
      "computer-use.snapshot.chunk",
    ]);
    expect(native.snapshot).toHaveBeenCalledTimes(1);
  });

  it("selected YOLO requires zero approvals even when Primary forces read-only", async () => {
    const f = fixture();
    const native = stubCapture(f.service);
    const selected = {
      ...authority,
      profile: {
        ...authority.profile,
        selectedId: ":yolo",
        effectiveId: ":read-only",
        forcedByWorktreePolicy: true,
      },
    };
    const lease = f.coordinator.open(selected);
    const result = await execute(
      f,
      {
        operation: "observation.snapshot",
        sessionId: "fixture-session",
        ...target,
      },
      lease,
      selected,
    );
    expect(result.result.status).toBe("ok");
    expect(
      result.events.every(
        (event) => event.type === "computer-use.snapshot.chunk",
      ),
    ).toBe(true);
    expect(f.approvals.status().pending).toBe(0);
    expect(native.snapshot).toHaveBeenCalledTimes(1);
    result.payload?.fill(0);
  });

  it("A-to-B-to-A creates new authority lifetimes and never restores an old grant", async () => {
    const f = fixture();
    const native = stubCapture(f.service);
    const a = f.coordinator.open(authority);
    const action = {
      operation: "observation.snapshot",
      sessionId: "fixture-session",
      ...target,
    } as const;
    const request = approval((await execute(f, action, a)).events);
    const originalAnswer = await answer(request);
    await f.coordinator.answer(originalAnswer);
    expect(f.approvals.status().grants).toBe(1);
    const bAuthority = {
      ...authority,
      generation: 2,
      placementId: "placement-b",
    };
    f.coordinator.open(bAuthority);
    const nextAuthority = { ...authority, generation: 3 };
    const next = f.coordinator.open(nextAuthority);
    expect(next.leaseId).not.toBe(a.leaseId);
    expect(f.approvals.status().grants).toBe(0);
    await expect(
      f.coordinator.answer({
        ...originalAnswer,
        previewAuthority: nextAuthority,
      }),
    ).rejects.toThrow();
    const result = await execute(f, action, next, nextAuthority);
    expect(result.result).toMatchObject({
      status: "error",
      code: "approval-required",
    });
    expect(approval(result.events).requestKey).not.toBe(request.requestKey);
    expect(native.snapshot).not.toHaveBeenCalled();
  });

  it("an inert reopen after Stop cannot import an old lease's operation or grant", async () => {
    const f = fixture();
    const native = stubCapture(f.service);
    const first = f.coordinator.open(authority);
    const action = {
      operation: "observation.snapshot",
      sessionId: "fixture-session",
      ...target,
    } as const;
    const pending = await execute(f, action, first);
    const response = await answer(approval(pending.events));
    await f.coordinator.answer(response);
    expect(f.approvals.status().grants).toBe(1);
    stop(f, first);
    // Opening is deliberately inert. Even the same authority must receive a
    // new random lease; it does not authorize or replay any native operation.
    const reopened = f.coordinator.open(authority);
    expect(reopened.leaseId).not.toBe(first.leaseId);
    expect(f.approvals.status().grants).toBe(0);
    await expect(f.coordinator.answer(response)).rejects.toThrow();
    await expect(
      f.coordinator.execute(
        {
          ...pending.request,
          preview: { leaseId: reopened.leaseId, authority },
        },
        async () => {},
      ),
    ).rejects.toThrow();
    const retried = await execute(f, action, reopened);
    expect(retried.result).toMatchObject({
      status: "error",
      code: "approval-required",
    });
    expect(approval(retried.events).requestKey).not.toBe(
      approval(pending.events).requestKey,
    );
    expect(native.snapshot).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("Stop during approval publication emits terminal after create and rejects late approval without replay", async () => {
    const f = fixture();
    const native = stubCapture(f.service);
    const lease = f.coordinator.open(authority);
    const started = deferred();
    const publication = deferred();
    const terminal = deferred();
    const events: CuaPreviewEvent[] = [];
    let pendingRequest: EncryptedAgentInteractionRequestCreate | undefined;
    const packet = await command(
      {
        operation: "observation.snapshot",
        sessionId: "fixture-session",
        ...target,
      },
      lease,
    );
    const execution = f.coordinator.execute(packet, async (event) => {
      if (event.type === "computer-use.approval.request") {
        pendingRequest = event.request;
        started.resolve();
        await publication.promise;
      }
      events.push(event);
      if (event.type === "computer-use.approval.terminal") terminal.resolve();
    });
    await started.promise;
    expect(stop(f, lease)).toEqual({ closed: true });
    await execution;
    expect(events).toEqual([]);
    publication.resolve();
    await terminal.promise;
    expect(events.map((event) => event.type)).toEqual([
      "computer-use.approval.request",
      "computer-use.approval.terminal",
    ]);
    expect(events[1]).toMatchObject({
      status: "interrupted",
      requestKey: pendingRequest!.requestKey,
    });
    await expect(
      f.coordinator.answer(await answer(pendingRequest!)),
    ).rejects.toThrow();
    await expect(
      f.coordinator.execute(packet, async () => {}),
    ).rejects.toThrow();
    expect(native.snapshot).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(stop(f, lease)).toEqual({ closed: true });
  });

  it.each([
    "ownerId",
    "serverId",
    "workerId",
    "chatId",
    "generation",
    "placementId",
    "profile",
  ] as const)(
    "validates current server authority %s on protected approval responses",
    async (field) => {
      const f = fixture();
      const lease = f.coordinator.open(authority);
      const request = approval(
        (await execute(f, { operation: "targets.list" }, lease)).events,
      );
      const changed = {
        ...authority,
        [field]:
          field === "generation"
            ? 2
            : field === "profile"
              ? { ...authority.profile, selectedId: ":yolo" }
              : "foreign",
      } as CuaPreviewAuthority;
      await expect(
        f.coordinator.answer(await answer(request, changed)),
      ).rejects.toThrow();
      expect(f.approvals.status().grants).toBe(0);
      expect(f.launch).not.toHaveBeenCalled();
    },
  );

  it("rejects a response without the current server authority and rejects Stop for a foreign owner/server/chat", async () => {
    const f = fixture();
    const lease = f.coordinator.open(authority);
    const request = approval(
      (await execute(f, { operation: "targets.list" }, lease)).events,
    );
    const response = await answer(request);
    delete response.previewAuthority;
    await expect(f.coordinator.answer(response)).rejects.toThrow();
    for (const field of ["ownerId", "serverId", "chatId"] as const) {
      expect(() =>
        f.coordinator.stop({
          ownerId: "owner",
          serverId: "server",
          chatId: "chat",
          leaseId: lease.leaseId,
          [field]: "foreign",
        }),
      ).toThrow();
    }
    expect(f.coordinator.open(authority)).toEqual(lease);
    expect(f.launch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "preview -> actual Rust fake capture",
  () => {
    it("preview cleanup releases its actual native session but leaves the same-chat agent session usable", async () => {
      const f = fixture(process.env.CANTRIP_CUA_TEST_BINARY!);
      const selected = {
        ...authority,
        profile: {
          ...authority.profile,
          selectedId: ":yolo",
          effectiveId: ":yolo",
        },
      };
      const lease = f.coordinator.open(selected);
      const opened = await execute(
        f,
        { operation: "session.open", ...target },
        lease,
        selected,
      );
      expect(opened.result.status).toBe("ok");
      const agentScope: CuaScope = {
        ownerId: "owner",
        serverId: "server",
        workerId: "worker",
        chatId: "chat",
        taskId: "task",
        threadId: "thread",
        turnId: "turn",
      };
      const agent = await f.service.open(agentScope, target);
      expect(f.service.status().sessions).toBe(2);
      f.coordinator.disconnect();
      expect(f.service.status().sessions).toBe(1);
      expect(
        (await f.service.snapshot(agentScope, agent.binding.sessionId, target))
          .image.width,
      ).toBeGreaterThan(0);
      expect(f.cancelChat).not.toHaveBeenCalled();
    });
    it("starts no helper until inventory/session approval, then captures only after the separately approved explicit retry", async () => {
      const f = fixture(process.env.CANTRIP_CUA_TEST_BINARY!);
      const lease = f.coordinator.open(authority);
      const openAction = { operation: "session.open", ...target } as const;
      const opening = await execute(f, openAction, lease);
      expect(opening.result).toMatchObject({
        status: "error",
        code: "approval-required",
      });
      expect(f.launch).not.toHaveBeenCalled();
      await f.coordinator.answer(await answer(approval(opening.events)));
      expect(f.launch).not.toHaveBeenCalled();
      const opened = await execute(f, openAction, lease);
      if (opened.result.status !== "ok" || !("session" in opened.result.data))
        throw new Error("Expected a Rust session.");
      expect(opened.result.data.session.binding).toMatchObject({
        chatId: "chat",
        taskId: null,
        threadId: null,
        turnId: null,
      });
      expect(f.launch).toHaveBeenCalledTimes(1);
      for (let observer = 0; observer < 20; observer += 1) {
        const observerLease = f.coordinator.open(structuredClone(authority));
        expect(observerLease).toEqual(lease);
        const reopened = await execute(f, openAction, observerLease);
        expect(reopened.result).toMatchObject({
          status: "ok",
          data: { session: { binding: opened.result.data.session.binding } },
        });
      }
      expect(f.service.status().sessions).toBe(1);
      const captureAction = {
        operation: "observation.snapshot",
        sessionId: opened.result.data.session.binding.sessionId,
        ...target,
      } as const;
      const capture = await execute(f, captureAction, lease);
      expect(capture.result).toMatchObject({
        status: "error",
        code: "approval-required",
      });
      expect(capture.payload).toBeNull();
      expect(
        f.service.state(
          {
            ownerId: "owner",
            serverId: "server",
            workerId: "worker",
            chatId: "chat",
            taskId: null,
            threadId: null,
            turnId: null,
          },
          captureAction.sessionId,
        ).observationRevision,
      ).toBe(0);
      await f.coordinator.answer(await answer(approval(capture.events)));
      expect(
        f.service.state(
          {
            ownerId: "owner",
            serverId: "server",
            workerId: "worker",
            chatId: "chat",
            taskId: null,
            threadId: null,
            turnId: null,
          },
          captureAction.sessionId,
        ).observationRevision,
      ).toBe(0);
      const retried = await execute(f, captureAction, lease);
      expect(retried.result).toMatchObject({
        status: "ok",
        data: {
          image: {
            mediaType: "image/png",
            width: 640,
            height: 360,
            cursorIncluded: true,
          },
        },
      });
      expect(Array.from(retried.payload!.subarray(0, 8))).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      retried.payload?.fill(0);
      expect(stop(f, lease)).toEqual({ closed: true });
      expect(f.service.status().sessions).toBe(0);
      await expect(
        f.coordinator.execute(capture.request, async () => {}),
      ).rejects.toThrow();
      expect(f.launch).toHaveBeenCalledTimes(1);
    });
  },
);
