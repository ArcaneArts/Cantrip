import { createHash, randomUUID } from "node:crypto";
import type { CantripMcpBinding } from "@cantrip/protocol";
import type { CuaPreviewAuthority } from "@cantrip/protocol/computer-use-preview";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CuaAgentObservations } from "./agent-observations.js";
import { CuaAgentCoordinator, type CuaAgentCommand } from "./agent.js";
import { CuaAgentApprovalEvents } from "./agent-approval-events.js";
import type { CuaApprovalManager } from "./approvals.js";
import { adaptCuaModelImages, type CuaModelImage } from "./model-images.js";
import type { CantripCuaService } from "./service.js";
import type { CuaSession } from "./types.js";

// Control the adapter completion independently from evaluation completion.
// Actual Sharp + Rust + stdio coverage lives in the integration suites.
vi.mock("./model-images.js", () => ({ adaptCuaModelImages: vi.fn() }));
const adapt = vi.mocked(adaptCuaModelImages);
const authority: CuaPreviewAuthority = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project",
  placementId: "placement",
  generation: 1,
  profile: {
    selectedId: ":yolo",
    effectiveId: ":yolo",
    forcedByWorktreePolicy: false,
    usesDefault: true,
  },
};
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6NQAAAAASUVORK5CYII=",
  "base64",
);
function image(threadId = "root"): CuaModelImage {
  const metadata = {
    width: 1,
    height: 1,
    byteCount: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    native: {
      session: {
        binding: {
          workerId: "worker",
          chatId: "chat",
          taskId: "task",
          threadId,
          turnId: `${threadId}-turn`,
          sessionId: `${threadId}-session`,
        },
        target: {
          id: "target",
          generation: 1,
          kind: "window",
          title: "fixture",
          application: null,
          processId: null,
          bounds: { x: -500, y: 40, width: 200, height: 100 },
          pixelWidth: 400,
          pixelHeight: 200,
          scaleFactor: 2,
          focused: false,
          minimized: false,
        },
        cursor: {
          appearance: {
            version: 1,
            style: "dot",
            color: "#ffffff",
            size: 12,
            label: null,
            trail: false,
            visible: true,
          },
          position: { x: 10, y: 20 },
          trailPoints: [],
          updatedAtMs: 1,
          revision: 2,
        },
        observationRevision: 3,
      },
      image: {
        ...metadata,
        width: 400,
        height: 200,
        mediaType: "image/png",
        cursorIncluded: true,
      },
    },
    model: metadata,
    content: {
      type: "image",
      mimeType: "image/png",
      data: bytes.toString("base64"),
    },
  };
}
function publish(
  cache: CuaAgentObservations,
  lifetime = {},
  result = image(),
  signal = new AbortController().signal,
  current = () => result.native.session,
) {
  const token = cache.begin(lifetime);
  cache.publish(lifetime, token, {
    authority,
    rootThreadId: "root",
    image: result,
    signal,
    current,
  });
  return { lifetime, token, source: cache.list(authority).sources.at(-1)! };
}

describe("bounded completed agent observations", () => {
  it("bounds concurrent decoded readers until cleanup even after source retirement", () => {
    const cache = new CuaAgentObservations();
    const { lifetime, source } = publish(cache);
    const readers = Array.from({ length: 4 }, () =>
      cache.read(authority, source.sourceId),
    );
    expect(() => cache.read(authority, source.sourceId)).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    cache.begin(lifetime);
    expect(readers.every((reader) => reader.signal.aborted)).toBe(true);
    const next = publish(cache);
    expect(() => cache.read(authority, next.source.sourceId)).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    readers[0]!.payload.fill(0);
    readers[0]!.release();
    readers[0]!.release();
    const resumed = cache.read(authority, next.source.sourceId);
    expect(() => cache.read(authority, next.source.sourceId)).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    for (const reader of [...readers, resumed]) {
      reader.payload.fill(0);
      reader.release();
    }
    const afterCleanup = cache.read(authority, next.source.sourceId);
    afterCleanup.payload.fill(0);
    afterCleanup.release();
  });

  it("releases reader reservations when bounded base64 decoding fails", () => {
    const cache = new CuaAgentObservations();
    const corrupt = image();
    corrupt.content.data = "!".repeat(corrupt.content.data.length);
    const { source } = publish(cache, {}, corrupt);
    for (let i = 0; i < 6; i++) {
      expect(() => cache.read(authority, source.sourceId)).toThrow(
        expect.objectContaining({ code: "protocol-error" }),
      );
    }
    const valid = publish(cache);
    const reader = cache.read(authority, valid.source.sourceId);
    expect(reader.payload).toEqual(bytes);
    reader.payload.fill(0);
    reader.release();
  });

  it("returns identical model bytes and separate native metadata through fresh owned buffers", () => {
    const cache = new CuaAgentObservations();
    const { source } = publish(cache);
    expect(source.sourceId).toMatch(/^[\da-f-]{36}$/);
    const first = cache.read(authority, source.sourceId);
    expect(first.payload).toEqual(bytes);
    expect(first.image.width).toBe(1);
    expect(first.nativeImage.width).toBe(400);
    expect(first.source.target.bounds.x).toBe(-500);
    first.payload.fill(0);
    first.release();
    first.session.binding.sessionId = "changed";
    first.source.target.bounds.x = 999;
    const second = cache.read(authority, source.sourceId);
    expect(second.payload).toEqual(bytes);
    expect(second.session.binding.sessionId).toBe("root-session");
    expect(second.source.target.bounds.x).toBe(-500);
    second.payload.fill(0);
    second.release();
  });

  it("requires every durable authority claim without requiring an execution lane", () => {
    const cache = new CuaAgentObservations();
    const { source } = publish(cache);
    for (const change of [
      { ownerId: "other" },
      { serverId: "other" },
      { workerId: "other" },
      { chatId: "other" },
      { projectId: "other" },
      { contextKind: "standalone" },
      { placementId: "other" },
      { generation: 2 },
      ...Object.keys(authority.profile).map((key) => ({
        profile: {
          ...authority.profile,
          [key]:
            typeof authority.profile[key as keyof typeof authority.profile] ===
            "boolean"
              ? !authority.profile[key as keyof typeof authority.profile]
              : "other",
        },
      })),
    ]) {
      const changed = { ...authority, ...change } as CuaPreviewAuthority;
      expect(cache.list(changed).sources).toEqual([]);
      expect(() => cache.read(changed, source.sourceId)).toThrow();
    }
    expect(cache.list(authority).sources).toHaveLength(1);
  });

  it("evicts the oldest of four entries and never restores evicted epochs", () => {
    const cache = new CuaAgentObservations();
    const first = publish(cache);
    const inFlight = cache.read(authority, first.source.sourceId);
    for (let i = 0; i < 4; i++) publish(cache, {}, image(`child-${i}`));
    expect(cache.list(authority).sources).toHaveLength(4);
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.payload.fill(0);
    inFlight.release();
    expect(() => cache.read(authority, first.source.sourceId)).toThrow();
    cache.publish(first.lifetime, first.token, {
      authority,
      rootThreadId: "root",
      image: image(),
      signal: new AbortController().signal,
      current: () => image().native.session,
    });
    expect(
      cache
        .list(authority)
        .sources.some((source) => source.binding.threadId === "root"),
    ).toBe(false);
  });

  it("retires sources on session loss, target replacement or revision changes permanently", () => {
    const changes: Array<(session: CuaSession) => CuaSession | null> = [
      () => null,
      (session) => ({
        ...session,
        binding: { ...session.binding, sessionId: "replacement" },
      }),
      (session) => ({ ...session, target: null }),
      (session) => ({
        ...session,
        target: { ...session.target!, generation: 2 },
      }),
      (session) => ({ ...session, cursor: { ...session.cursor, revision: 3 } }),
      (session) => ({ ...session, observationRevision: 4 }),
    ];
    for (const change of changes) {
      const cache = new CuaAgentObservations();
      const result = image();
      let current: CuaSession | null = result.native.session;
      const token = cache.begin(result);
      cache.publish(result, token, {
        authority,
        rootThreadId: "root",
        image: result,
        signal: new AbortController().signal,
        current: () => current,
      });
      const source = cache.list(authority).sources[0]!;
      const inFlight = cache.read(authority, source.sourceId);
      current = change(current!);
      expect(cache.list(authority).sources).toEqual([]);
      expect(inFlight.signal.aborted).toBe(true);
      inFlight.payload.fill(0);
      inFlight.release();
      current = result.native.session;
      expect(() => cache.read(authority, source.sourceId)).toThrow();
    }
  });

  it("clears on cancellation and rejects oversized images without allocating reader bytes", () => {
    const cache = new CuaAgentObservations();
    const controller = new AbortController();
    const { source } = publish(cache, {}, image(), controller.signal);
    controller.abort();
    expect(() => cache.read(authority, source.sourceId)).toThrow();
    const oversized = image();
    oversized.model.byteCount = 2.5 * 1024 * 1024 + 1;
    publish(cache, {}, oversized);
    expect(cache.list(authority).sources).toEqual([]);
  });
});

function coordinatorFixture() {
  const native = new AbortController();
  const javascriptContext = new AbortController();
  const request = new AbortController();
  let session: CuaSession | null = image().native.session;
  const service = {
    evaluateJavascript: vi.fn(async () => ({ value: 1, images: [] })),
    resetJavascript: vi.fn(async () => {
      session = null;
    }),
    javascriptSession: vi.fn(() => session),
    javascriptSessionSignal: vi.fn(() => javascriptContext.signal),
    cancelScope: vi.fn(() => {
      session = null;
    }),
  };
  const agentAuthority = { ...authority, executionLaneId: "lane" };
  const coordinator = new CuaAgentCoordinator({
    service: service as unknown as CantripCuaService,
    approvals: { revokeContext: vi.fn() } as unknown as CuaApprovalManager,
    events: new CuaAgentApprovalEvents(),
    identity: () => authority,
    authority: async () => agentAuthority,
  });
  const command: CuaAgentCommand = {
    ...agentAuthority,
    initialAuthority: agentAuthority,
    taskId: "task",
    rootThreadId: "root",
    ownsThread: (thread) => thread === "root",
    publish: async () => {},
    resolve: ({ chatId, threadId, turnId }) => ({
      chatId,
      threadId,
      turnId,
      rootThreadId: "root",
      rootTurnId: "root-turn",
      parentThreadId: null,
      signal: native.signal,
    }),
  };
  const unregister = coordinator.register(command);
  const claims = {
    ...authority,
    executionLaneId: "lane",
    worktreeId: "placement",
    scratchRootId: null,
  } as unknown as CantripMcpBinding;
  const call = (operation: "js" | "js_reset" = "js") =>
    coordinator.execute(
      claims,
      {
        operation,
        ...(operation === "js" ? { script: "1" } : {}),
        threadId: "root",
        turnId: "root-turn",
        itemId: null,
        callId: null,
      } as never,
      randomUUID(),
      request.signal,
    );
  return {
    coordinator,
    service,
    call,
    native,
    javascriptContext,
    request,
    unregister,
  };
}
beforeEach(() => adapt.mockReset().mockResolvedValue([image()]));

describe("coordinator observation lifetime fencing", () => {
  it.each([
    "reset",
    "error",
    "stop",
    "cancel",
    "complete",
    "native context failure",
    "disconnect",
    "release",
    "revoke",
  ])("clears completed observations on %s", async (action) => {
    const f = coordinatorFixture();
    await f.call();
    const source = f.coordinator.listObservations(authority).sources[0]!;
    expect(source).toBeDefined();
    const inFlight = f.coordinator.readObservation(authority, source.sourceId);
    expect(inFlight.signal.aborted).toBe(false);
    if (action === "reset") await f.call("js_reset");
    if (action === "error") {
      f.service.evaluateJavascript.mockRejectedValueOnce(new Error("failed"));
      await expect(f.call()).rejects.toThrow();
    }
    if (action === "stop") f.coordinator.cancelThread("root");
    if (action === "cancel") f.request.abort();
    if (action === "complete") f.native.abort();
    if (action === "native context failure") {
      f.javascriptContext.abort();
      expect(f.native.signal.aborted).toBe(false);
      // No list/read validation is needed to retire the in-flight payload.
      expect(inFlight.signal.aborted).toBe(true);
    }
    if (action === "disconnect") f.coordinator.disconnect();
    if (action === "release") await f.unregister();
    if (action === "revoke")
      f.coordinator.revoke({
        ownerId: "owner",
        serverId: "server",
        scope: { kind: "chat", chatId: "chat" },
      });
    expect(f.coordinator.listObservations(authority).sources).toEqual([]);
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.payload.fill(0);
    inFlight.release();
    expect(() =>
      f.coordinator.readObservation(authority, source.sourceId),
    ).toThrow();
    await f.unregister();
  });

  it("clears before the next evaluation and fences a late older adapter without deleting newer results", async () => {
    const f = coordinatorFixture();
    await f.call();
    const priorSource = f.coordinator.listObservations(authority).sources[0]!;
    const inFlight = f.coordinator.readObservation(
      authority,
      priorSource.sourceId,
    );
    let finish!: (images: CuaModelImage[]) => void;
    adapt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const older = f.call();
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.payload.fill(0);
    inFlight.release();
    expect(f.coordinator.listObservations(authority).sources).toEqual([]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.call();
    const latest = f.coordinator.listObservations(authority).sources[0]!;
    finish([image()]);
    await older;
    expect(f.coordinator.listObservations(authority).sources).toEqual([latest]);
    await f.unregister();
  });

  it("a cancelled late adapter cannot resurrect a source", async () => {
    const f = coordinatorFixture();
    let finish!: (images: CuaModelImage[]) => void;
    adapt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.call();
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.coordinator.cancelChat("chat");
    finish([image()]);
    await expect(pending).rejects.toThrow();
    expect(f.coordinator.listObservations(authority).sources).toEqual([]);
    await f.unregister();
  });
});
