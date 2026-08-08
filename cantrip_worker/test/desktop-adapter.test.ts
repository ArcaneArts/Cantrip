import type { ToolResult } from "@zavora-ai/computer-use-mcp/client";
import { remoteDesktopServerMessageSchema } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ManagedDesktopRemoteSurfaceAdapter,
  type DesktopAutomationClient,
} from "../src/desktop/desktop-adapter.js";

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
      async () => desktopTargets,
      async () => undefined,
    );
    await adapter.initialize();
    expect(adapter.available).toBe(true);
    await expect(adapter.probe()).resolves.toEqual({
      available: true,
      message: null,
    });
    expect(capture).not.toHaveBeenCalled();

    const emissions: Array<{ channel: string; payload: Uint8Array }> = [];
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "desktop-1",
        attachmentId: "attachment-1",
        projectId: "project-1",
        configuration: {
          kind: "desktop",
          target: { kind: "monitor", id: null, name: null },
        },
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
    session.attach({
      id: "attachment-1",
      viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
    });
    await eventually(() =>
      emissions.some(({ channel }) => channel === "frame"),
    );
    await eventually(() => capture.mock.calls.length >= 4);
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

    await session.handleFrame(
      "attachment-1",
      "control",
      new TextEncoder().encode(JSON.stringify({ type: "refresh-targets" })),
    );
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
    expect(client.mouseDown).toHaveBeenCalledWith(12, 20);
    expect(client.mouseUp).toHaveBeenCalledWith(12, 20);
    expect(client.type).toHaveBeenCalledWith("a");
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

  it("launches a missing saved application and switches to its window", async () => {
    let launched = false;
    const launchApplication = vi.fn(async () => {
      launched = true;
    });
    const client = {
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
              id: "window-7",
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
                id: "window-7",
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
    const emissions: Uint8Array[] = [];
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "desktop-window",
        attachmentId: "attachment-window",
        projectId: "project-1",
        configuration: {
          kind: "desktop",
          target: {
            kind: "window",
            id: "old-window-id",
            application: "Code",
            title: "Cantrip",
          },
        },
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
        message: "Launching Code on the worker…",
      }),
    );
    expect(
      messages.find((message) => message.type === "desktop-targets"),
    ).toMatchObject({
      active: { kind: "window", application: "Code", title: "Cantrip" },
      requested: { kind: "window", application: "Code", title: "Cantrip" },
    });
    session.close();
    await adapter.shutdown();
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
