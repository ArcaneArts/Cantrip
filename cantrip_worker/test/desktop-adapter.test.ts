import type { ToolResult } from "@zavora-ai/computer-use-mcp/client";
import {
  decryptSurfacePrivateState,
  encryptSurfacePrivateState,
} from "@cantrip/crypto";
import { remoteDesktopServerMessageSchema } from "@cantrip/protocol";
import {
  remoteDesktopPrivateInventoryProtectedContentSchema,
  type SurfacePrivateStateOpaque,
} from "@cantrip/protocol/surface-private-state";
import { describe, expect, it, vi } from "vitest";

import {
  ManagedDesktopRemoteSurfaceAdapter,
  type DesktopAutomationClient,
} from "../src/desktop/desktop-adapter.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { readWorkerLogs } from "../src/logger.js";

const ownerId = "desktop-owner";
const serverId = "desktop-server";
const workerId = "desktop-worker";
const componentKey = new Uint8Array(32).fill(47);
const encryptionService = {
  status: () => ({ error: null }),
  ownerId: () => ownerId,
  componentKey: () => ({ key: componentKey.slice(), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;

async function protectedTarget(
  surfaceId: string,
  target:
    | { kind: "monitor"; id: string | null; name: string | null }
    | {
        kind: "window";
        id: string | null;
        application: string;
        title: string | null;
      },
  revision = 1,
): Promise<SurfacePrivateStateOpaque> {
  return encryptSurfacePrivateState({
    ownerId,
    context: {
      serverId,
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
      revision,
      target,
    },
  });
}

async function openInventory(
  message: Extract<
    ReturnType<typeof remoteDesktopServerMessageSchema.parse>,
    { type: "desktop-targets" }
  >,
  resourceId: string,
) {
  return remoteDesktopPrivateInventoryProtectedContentSchema.parse(
    await decryptSurfacePrivateState({
      ownerId,
      context: {
        serverId,
        resource: "remote-desktop-inventory",
        resourceId,
        operationId: message.operationId,
        recordKind: "remote-desktop-inventory",
      },
      keyRevision: 1,
      componentKey,
      opaque: message.stateProtection,
    }),
  );
}

function textResult(
  text = "ok",
  structuredContent?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

const desktopTargets = {
  monitors: [
    {
      kind: "monitor" as const,
      id: "display-1",
      name: "Primary",
      x: 0,
      y: 0,
      width: 1_920,
      height: 1_080,
      primary: true,
    },
  ],
  windows: [],
};

async function eventually(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000)
      throw new Error("Timed out waiting for desktop frame.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ManagedDesktopRemoteSurfaceAdapter", () => {
  it("probes, streams, and controls the worker desktop", async () => {
    const screenshot = vi.fn(async (): Promise<ToolResult> => ({
      content: [
        {
          type: "image",
          data: Buffer.from("jpeg").toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
    }));
    const client = {
      activateWindow: vi.fn(async () => textResult('{"activated":true}')),
      click: vi.fn(async () => textResult()),
      close: vi.fn(async () => undefined),
      doubleClick: vi.fn(async () => textResult()),
      getDisplaySize: vi.fn(async () =>
        textResult('{"width":1920,"height":1080}', {
          width: 1920,
          height: 1080,
        }),
      ),
      key: vi.fn(async () => textResult()),
      middleClick: vi.fn(async () => textResult()),
      mouseDown: vi.fn(async () => textResult()),
      mouseUp: vi.fn(async () => textResult()),
      moveMouse: vi.fn(async () => textResult()),
      readClipboard: vi.fn(async () => textResult("remote text")),
      rightClick: vi.fn(async () => textResult()),
      screenshot,
      scroll: vi.fn(async () => textResult()),
      type: vi.fn(async () => textResult()),
    } satisfies DesktopAutomationClient;
    const capture = vi.fn(async () => ({
      width: 1_920,
      height: 1_080,
      rgba: new Uint8Array(1_920 * 4),
    }));
    const encode = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const applicationIcons = {
      register: vi.fn((application: string) => `icon-${application}`),
      resolve: vi.fn(async (key: string) => ({
        key,
        mimeType: "image/png" as const,
        data: Buffer.from("icon").toString("base64"),
      })),
    };
    const listTargets = vi.fn(async () => desktopTargets);
    const adapter = new ManagedDesktopRemoteSurfaceAdapter(
      async () => client,
      async () => ({
        backend: "native",
        target: { kind: "monitor", id: "display-1", name: "Primary" },
        display: { width: 1_920, height: 1_080 },
        origin: { x: 0, y: 0 },
        capture,
        encode,
      }),
      listTargets,
      async () => undefined,
      applicationIcons,
    );
    await adapter.initialize();
    adapter.setSurfacePrivateStateService(encryptionService, workerId);
    expect(adapter.available).toBe(true);
    await expect(adapter.probe()).resolves.toEqual({
      available: true,
      message: null,
    });
    const protectedInventory = await adapter.targets({
      type: "surface.desktop.targets",
      serverId,
      operationId: "00000000-0000-4000-8000-000000000801",
      resourceId: workerId,
      limit: 100,
    });
    expect(JSON.stringify(protectedInventory)).not.toContain("Primary");
    await expect(
      openInventory(
        {
          type: "desktop-targets",
          operationId: protectedInventory.operationId,
          stateProtection: protectedInventory.stateProtection,
          monitorCount: protectedInventory.monitorCount,
          windowCount: protectedInventory.windowCount,
        },
        workerId,
      ),
    ).resolves.toMatchObject(desktopTargets);
    await expect(
      adapter.targets({
        type: "surface.desktop.targets",
        serverId,
        operationId: protectedInventory.operationId,
        resourceId: workerId,
        limit: 100,
      }),
    ).rejects.toThrow(/replayed/u);
    await expect(
      adapter.targets({
        type: "surface.desktop.targets",
        serverId,
        operationId: "00000000-0000-4000-8000-000000000802",
        resourceId: "another-worker",
        limit: 100,
      }),
    ).rejects.toThrow(/another worker/u);
    expect(capture).not.toHaveBeenCalled();

    const emissions: Array<{ channel: string; payload: Uint8Array }> = [];
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "desktop-1",
        attachmentId: "attachment-1",
        projectId: "project-1",
        serverId,
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        stateRevision: 1,
        stateProtection: await protectedTarget("desktop-1", {
          kind: "monitor",
          id: null,
          name: null,
        }),
        preferredTransport: "websocket",
        viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
        webrtc: null,
        desktopStream: { targetFps: 60, quality: "adaptive" },
      },
      (_attachmentId, channel, payload) => {
        emissions.push({ channel, payload });
        return true;
      },
    );
    let releaseInventory!: () => void;
    const inventoryPending = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    listTargets.mockClear();
    listTargets.mockImplementationOnce(async () => {
      await inventoryPending;
      return desktopTargets;
    });
    const firstAttach = session.attach({
      id: "attachment-1",
      viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
    });
    let secondAttached = false;
    const secondAttach = Promise.resolve(
      session.attach({
        id: "attachment-2",
        viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
      }),
    ).then(() => {
      secondAttached = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAttached).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(listTargets).toHaveBeenCalledOnce();
    releaseInventory();
    await Promise.all([firstAttach, secondAttach]);
    session.detach("attachment-2");
    await eventually(() =>
      emissions.some(({ channel }) => channel === "frame"),
    );
    await eventually(() => capture.mock.calls.length >= 4);
    expect(listTargets).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1_920, height: 1_080 }),
      expect.objectContaining({ quality: expect.any(Number), width: 1_280 }),
    );
    const state = emissions.find(({ channel }) => channel === "control");
    expect(
      state &&
        remoteDesktopServerMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(state.payload)),
        ),
    ).toMatchObject({ type: "desktop-state", width: 1920, height: 1080 });

    const targetMessageCount = () =>
      emissions.filter(({ channel, payload }) => {
        if (channel !== "control") return false;
        return (
          remoteDesktopServerMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          ).type === "desktop-targets"
        );
      }).length;
    const targetsBeforeReadyViewport = targetMessageCount();
    await session.handleFrame(
      "attachment-1",
      "control",
      new TextEncoder().encode(
        JSON.stringify({
          type: "viewport",
          viewport: { width: 1_440, height: 900, devicePixelRatio: 1 },
        }),
      ),
    );
    expect(targetMessageCount()).toBe(targetsBeforeReadyViewport + 1);
    await session.handleFrame(
      "attachment-1",
      "control",
      new TextEncoder().encode(
        JSON.stringify({
          type: "viewport",
          viewport: { width: 1_600, height: 900, devicePixelRatio: 1 },
        }),
      ),
    );
    expect(targetMessageCount()).toBe(targetsBeforeReadyViewport + 1);
    expect(listTargets).toHaveBeenCalledOnce();

    await session.handleFrame(
      "attachment-1",
      "control",
      new TextEncoder().encode(JSON.stringify({ type: "refresh-targets" })),
    );
    expect(listTargets).toHaveBeenCalledTimes(2);
    expect(
      emissions.some(({ channel, payload }) => {
        if (channel !== "control") return false;
        return (
          remoteDesktopServerMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          ).type === "desktop-targets"
        );
      }),
    ).toBe(true);
    const targetMessage = emissions
      .filter(({ channel }) => channel === "control")
      .map(({ payload }) =>
        remoteDesktopServerMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(payload)),
        ),
      )
      .find((message) => message.type === "desktop-targets");
    expect(targetMessage?.type).toBe("desktop-targets");
    if (targetMessage?.type === "desktop-targets") {
      await expect(
        openInventory(targetMessage, "desktop-1"),
      ).resolves.toMatchObject({
        monitors: desktopTargets.monitors,
        requested: { kind: "monitor", id: null, name: null },
      });
    }
    await session.updateConfiguration?.(
      { kind: "desktop" },
      {
        serverId,
        stateResource: "remote-desktop-row",
        stateRevision: 2,
        stateProtection: await protectedTarget(
          "desktop-1",
          { kind: "monitor", id: "display-1", name: "Primary" },
          2,
        ),
      },
    );
    const reconfiguredMessage = emissions
      .filter(({ channel }) => channel === "control")
      .map(({ payload }) =>
        remoteDesktopServerMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(payload)),
        ),
      )
      .filter((message) => message.type === "desktop-targets")
      .at(-1);
    if (reconfiguredMessage?.type === "desktop-targets") {
      await expect(
        openInventory(reconfiguredMessage, "desktop-1"),
      ).resolves.toMatchObject({
        requested: { kind: "monitor", id: "display-1", name: "Primary" },
      });
    }
    await expect(
      session.updateConfiguration?.(
        { kind: "desktop" },
        {
          serverId,
          stateResource: "remote-desktop-row",
          stateRevision: 1,
          stateProtection: await protectedTarget("desktop-1", {
            kind: "monitor",
            id: null,
            name: null,
          }),
        },
      ),
    ).rejects.toThrow(/stale/u);

    await session.handleFrame(
      "attachment-1",
      "control",
      new TextEncoder().encode(
        JSON.stringify({
          type: "request-target-icons",
          keys: ["icon-Code"],
        }),
      ),
    );
    expect(applicationIcons.resolve).toHaveBeenCalledWith("icon-Code");
    expect(
      emissions.some(({ channel, payload }) => {
        if (channel !== "control") return false;
        const message = remoteDesktopServerMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(payload)),
        );
        return (
          message.type === "desktop-target-icons" &&
          message.icons[0]?.key === "icon-Code"
        );
      }),
    ).toBe(true);

    for (const message of [
      { type: "pointer", event: "down", x: 12, y: 20, button: "left" },
      { type: "pointer", event: "up", x: 12, y: 20, button: "left" },
      { type: "key", event: "down", key: "a", code: "KeyA", text: "a" },
      { type: "clipboard", operation: "copy", text: "" },
    ]) {
      await session.handleFrame(
        "attachment-1",
        "control",
        new TextEncoder().encode(JSON.stringify(message)),
      );
    }
    expect(client.mouseDown).toHaveBeenCalledWith(12, 20, undefined, undefined);
    expect(client.mouseUp).toHaveBeenCalledWith(12, 20, undefined, undefined);
    expect(client.type).toHaveBeenCalledWith("a", undefined, undefined);
    expect(
      emissions.some(({ channel, payload }) => {
        if (channel !== "clipboard") return false;
        return (
          remoteDesktopServerMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          ).type === "desktop-clipboard"
        );
      }),
    ).toBe(true);

    session.close();
    await adapter.shutdown();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("launches a saved application and focuses its window before input", async () => {
    const logCursor = readWorkerLogs({}).nextCursor;
    let launched = false;
    let focusFailure = false;
    const launchApplication = vi.fn(async () => {
      launched = true;
    });
    const focusTarget = vi.fn(async () =>
      textResult(
        focusFailure
          ? '{"activated":false,"reason":"activation_denied"}'
          : '{"activated":true,"reason":null}',
      ),
    );
    const client = {
      activateWindow: focusTarget,
      click: vi.fn(async () => textResult()),
      close: vi.fn(async () => undefined),
      doubleClick: vi.fn(async () => textResult()),
      getDisplaySize: vi.fn(async () =>
        textResult('{"width":1920,"height":1080}', {
          width: 1920,
          height: 1080,
        }),
      ),
      key: vi.fn(async () => textResult()),
      middleClick: vi.fn(async () => textResult()),
      mouseDown: vi.fn(async () => textResult()),
      mouseUp: vi.fn(async () => textResult()),
      moveMouse: vi.fn(async () => textResult()),
      readClipboard: vi.fn(async () => textResult()),
      rightClick: vi.fn(async () => textResult()),
      screenshot: vi.fn(async () => ({
        content: [
          {
            type: "image" as const,
            data: Buffer.from("jpeg").toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
      })),
      scroll: vi.fn(async () => textResult()),
      type: vi.fn(async () => textResult()),
    } satisfies DesktopAutomationClient;
    const listTargets = vi.fn(async () => ({
      ...desktopTargets,
      windows: launched
        ? [
            {
              kind: "window" as const,
              id: "7",
              application: "Code",
              title: "Cantrip",
              x: 100,
              y: 50,
              width: 1_200,
              height: 800,
              minimized: false,
              focused: true,
            },
          ]
        : [],
    }));
    const adapter = new ManagedDesktopRemoteSurfaceAdapter(
      async () => client,
      async (target = { kind: "monitor", id: null, name: null }) => {
        const windowTarget = target.kind === "window" && launched;
        return {
          backend: "native" as const,
          target: windowTarget
            ? {
                kind: "window" as const,
                id: "7",
                application: "Code",
                title: "Cantrip",
              }
            : {
                kind: "monitor" as const,
                id: "display-1",
                name: "Primary",
              },
          display: windowTarget
            ? { width: 1_200, height: 800 }
            : { width: 1_920, height: 1_080 },
          origin: windowTarget ? { x: 100, y: 50 } : { x: 0, y: 0 },
          capture: async () => ({
            width: windowTarget ? 1_200 : 1_920,
            height: windowTarget ? 800 : 1_080,
            rgba: new Uint8Array(4),
          }),
          encode: async () => new Uint8Array([1]),
        };
      },
      listTargets,
      launchApplication,
    );
    await adapter.initialize();
    adapter.setSurfacePrivateStateService(encryptionService, workerId);
    const emissions: Uint8Array[] = [];
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "desktop-window",
        attachmentId: "attachment-window",
        projectId: "project-1",
        serverId,
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        stateRevision: 1,
        stateProtection: await protectedTarget("desktop-window", {
          kind: "window",
          id: "old-window-id",
          application: "Code",
          title: "Cantrip",
        }),
        preferredTransport: "websocket",
        viewport: { width: 1_200, height: 800, devicePixelRatio: 1 },
        webrtc: null,
        desktopStream: { targetFps: 30, quality: "adaptive" },
      },
      (_attachmentId, channel, payload) => {
        if (channel === "control") emissions.push(payload);
        return true;
      },
    );
    await session.attach({
      id: "attachment-window",
      viewport: { width: 1_200, height: 800, devicePixelRatio: 1 },
    });

    expect(launchApplication).toHaveBeenCalledWith("Code");
    const messages = emissions.map((payload) =>
      remoteDesktopServerMessageSchema.parse(
        JSON.parse(new TextDecoder().decode(payload)),
      ),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "desktop-state",
        status: "launching",
        message: "Launching the selected application on the worker.",
      }),
    );
    const targets = messages.find(
      (message) => message.type === "desktop-targets",
    );
    expect(targets?.type).toBe("desktop-targets");
    if (targets?.type === "desktop-targets") {
      await expect(
        openInventory(targets, "desktop-window"),
      ).resolves.toMatchObject({
        active: { kind: "window", application: "Code", title: "Cantrip" },
        requested: {
          kind: "window",
          application: "Code",
          title: "Cantrip",
        },
      });
    }

    focusTarget.mockClear();
    await session.handleFrame(
      "attachment-window",
      "control",
      new TextEncoder().encode(
        JSON.stringify({
          type: "pointer",
          event: "down",
          x: 12,
          y: 20,
          button: "left",
        }),
      ),
    );
    expect(focusTarget).toHaveBeenCalledOnce();
    expect(focusTarget).toHaveBeenCalledWith(7, 2_000);
    expect(client.mouseDown).toHaveBeenCalledWith(112, 70, undefined, {
      focusStrategy: "strict",
      targetWindowId: 7,
    });
    expect(focusTarget.mock.invocationCallOrder[0]).toBeLessThan(
      client.mouseDown.mock.invocationCallOrder[0]!,
    );

    focusFailure = true;
    await expect(
      session.handleFrame(
        "attachment-window",
        "control",
        new TextEncoder().encode(
          JSON.stringify({
            type: "pointer",
            event: "down",
            x: 20,
            y: 30,
            button: "left",
          }),
        ),
      ),
    ).rejects.toThrow(
      "input was not sent: The operating system refused window activation: activation denied.",
    );
    expect(client.mouseDown).toHaveBeenCalledTimes(1);
    expect(
      emissions
        .map((payload) =>
          remoteDesktopServerMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          ),
        )
        .find(
          (message) =>
            message.type === "desktop-state" && message.status === "error",
        ),
    ).toMatchObject({
      message: "Remote Desktop input is unavailable.",
    });
    expect(JSON.stringify(messages)).not.toContain("Cantrip");
    expect(
      JSON.stringify(readWorkerLogs({ afterCursor: logCursor }).records),
    ).not.toContain("Cantrip");
    session.close();
    await adapter.shutdown();
  });

  it("routes production window input without focusing or using system pointer APIs", async () => {
    const activateWindow = vi.fn();
    const moveMouse = vi.fn();
    const client = {
      activateWindow,
      moveMouse,
      close: vi.fn(async () => {}),
      getDisplaySize: vi.fn(async () =>
        textResult('{"width":200,"height":200}', { width: 200, height: 200 }),
      ),
    } as unknown as DesktopAutomationClient;
    const send = vi.fn(async () => ({}));
    const close = vi.fn(async () => {});
    const open = vi.fn(
      async () =>
        ({
          send,
          close,
        }) as unknown as import("../src/computer-use/participants.js").InteractionParticipant,
    );
    const target = {
      kind: "window" as const,
      id: "42",
      application: "Brave",
      title: "Piano",
    };
    const adapter = new ManagedDesktopRemoteSurfaceAdapter(
      async () => client,
      async () => ({
        backend: "native",
        target,
        display: { width: 100, height: 100 },
        origin: { x: 50, y: 60 },
        capture: async () => ({
          width: 200,
          height: 200,
          rgba: new Uint8Array(200 * 200 * 4),
        }),
        encode: async () => new Uint8Array([1]),
      }),
      async () => ({
        monitors: [],
        windows: [
          {
            kind: "window" as const,
            x: 50,
            y: 60,
            id: "42",
            application: "Brave",
            title: "Piano",
            width: 100,
            height: 100,
            focused: false,
            minimized: false,
          },
        ],
      }),
      async () => {},
      null,
      { workerId, participants: { open } },
    );
    await adapter.initialize();
    adapter.setSurfacePrivateStateService(encryptionService, workerId);
    const messages: ReturnType<
      typeof remoteDesktopServerMessageSchema.parse
    >[] = [];
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "shared-input",
        attachmentId: "a",
        projectId: "project",
        serverId,
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        stateRevision: 1,
        stateProtection: await protectedTarget("shared-input", target),
        preferredTransport: "websocket",
        viewport: { width: 200, height: 200, devicePixelRatio: 1 },
        webrtc: null,
      },
      (_id, channel, payload) => {
        if (channel === "control")
          messages.push(
            remoteDesktopServerMessageSchema.parse(
              JSON.parse(new TextDecoder().decode(payload)),
            ),
          );
        return true;
      },
    );
    try {
      await session.attach({
        id: "a",
        viewport: { width: 200, height: 200, devicePixelRatio: 1 },
      });
      await eventually(() =>
        messages.some((m) => m.type === "desktop-state" && m.width === 200),
      );
      const state = messages.find((m) => m.type === "desktop-input" && m.epoch);
      expect(state?.type).toBe("desktop-input");
      if (state?.type !== "desktop-input")
        throw new Error("missing input epoch");
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "pointer",
          event: "down",
          x: 50,
          y: 80,
          button: "left",
          inputEpoch: state.epoch,
          inputSequence: 1,
        }),
      );
      await session.handleFrame("a", "control", payload);
      expect(send).toHaveBeenCalledWith(
        1,
        {
          type: "pointerDown",
          data: { point: { x: 25, y: 40 }, button: "left", modifiers: [] },
        },
        expect.any(AbortSignal),
      );
      expect(activateWindow).not.toHaveBeenCalled();
      expect(moveMouse).not.toHaveBeenCalled();
      await expect(
        session.handleFrame("a", "control", payload),
      ).rejects.toThrow(/stale/);
      await session.attach({
        id: "a",
        viewport: { width: 200, height: 200, devicePixelRatio: 1 },
      });
      const renewed = messages
        .filter((m) => m.type === "desktop-input" && m.epoch)
        .at(-1);
      if (renewed?.type !== "desktop-input")
        throw new Error("missing renewed input epoch");
      expect(renewed.epoch).not.toBe(state.epoch);
      await expect(
        session.handleFrame("a", "control", payload),
      ).rejects.toThrow(/stale/);
      const next = JSON.parse(new TextDecoder().decode(payload));
      next.inputEpoch = renewed.epoch;
      await session.handleFrame(
        "a",
        "control",
        new TextEncoder().encode(JSON.stringify(next)),
      );
      expect(open).toHaveBeenCalledTimes(2);
      session.detach("a");
      await eventually(() => close.mock.calls.length === 2);
    } finally {
      await session.close();
      await adapter.shutdown();
    }
  });

  it("reports an unavailable native desktop backend", async () => {
    const adapter = new ManagedDesktopRemoteSurfaceAdapter(async () => {
      throw new Error("native backend unavailable");
    });
    await adapter.initialize();
    expect(adapter.available).toBe(false);
    await expect(adapter.probe()).resolves.toEqual({
      available: false,
      message: "native backend unavailable",
    });
  });
});

it.skipIf(process.platform !== "darwin")(
  "uses shared capture without startup probes and recovers video without cancelling input",
  async () => {
    const target = {
      kind: "window" as const,
      id: "42",
      application: "Brave",
      title: "Piano",
    };
    const native = {
      id: "macos-window-42",
      generation: 1,
      kind: "window" as const,
      title: "Piano",
      application: "Brave",
      processId: 123,
      bounds: { x: 50, y: 60, width: 100, height: 100 },
      pixelWidth: 200,
      pixelHeight: 200,
      scaleFactor: 2,
      focused: false,
      minimized: false,
    };
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 200, height: 200, channels: 4, background: "#123456" },
    })
      .png()
      .toBuffer();
    let failNext = false;
    const closes: ReturnType<typeof vi.fn>[] = [];
    const captures = {
      inventory: vi.fn(async () => [native]),
      open: vi.fn(async () => {
        const close = vi.fn(async () => {});
        closes.push(close);
        return {
          initial: { target: native, handle: closes.length },
          close,
          frame: vi.fn(async () => {
            if (failNext) {
              failNext = false;
              throw new Error("transient capture failure");
            }
            return { target: native, png, width: 200, height: 200 };
          }),
        };
      }),
    };
    const inputClose = vi.fn(async () => {});
    const inputOpen = vi.fn(async () => ({
      send: vi.fn(),
      close: inputClose,
    })) as unknown as import("../src/computer-use/participants.js").WorkerInputParticipants["open"];
    const legacy = vi.fn(async () => {
      throw new Error("Legacy startup must not run");
    });
    const adapter = new ManagedDesktopRemoteSurfaceAdapter(
      legacy,
      legacy,
      legacy,
      async () => {},
      null,
      {
        workerId,
        participants: { open: inputOpen },
        captures:
          captures as unknown as import("../src/computer-use/captures.js").WorkerCaptures,
      },
    );
    await adapter.initialize();
    expect(legacy).not.toHaveBeenCalled();
    expect(captures.inventory).not.toHaveBeenCalled();
    adapter.setSurfacePrivateStateService(encryptionService, workerId);
    let frames = 0;
    let firstFrameMs = 0;
    const startedAt = performance.now();
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "shared-capture",
        attachmentId: "a",
        projectId: "project",
        serverId,
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        stateRevision: 1,
        stateProtection: await protectedTarget("shared-capture", target),
        preferredTransport: "websocket",
        viewport: { width: 200, height: 200, devicePixelRatio: 1 },
        webrtc: null,
      },
      (_id, channel) => {
        if (channel === "frame") {
          frames++;
          if (frames === 1) firstFrameMs = performance.now() - startedAt;
        }
        return true;
      },
    );
    try {
      await session.attach({
        id: "a",
        viewport: { width: 200, height: 200, devicePixelRatio: 1 },
      });
      await eventually(() => frames > 0);
      process.stdout.write(
        `Shared capture fixture: first frame ${firstFrameMs.toFixed(1)}ms, legacy startup calls ${legacy.mock.calls.length}, inventory calls ${captures.inventory.mock.calls.length}\n`,
      );
      expect(captures.inventory).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      const before = frames;
      failNext = true;
      await vi.waitFor(() => expect(captures.open).toHaveBeenCalledTimes(2), {
        timeout: 2000,
      });
      await eventually(() => frames > before);
      expect(inputClose).not.toHaveBeenCalled();
      expect(closes[0]).toHaveBeenCalledOnce();
      session.suspend();
      await vi.waitFor(() => expect(closes[1]).toHaveBeenCalledOnce());
      session.resume();
      await vi.waitFor(() => expect(captures.open).toHaveBeenCalledTimes(3));
      session.detach("a");
      await vi.waitFor(() => expect(closes[2]).toHaveBeenCalledOnce());
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      session.close();
      await adapter.shutdown();
    }
  },
);
