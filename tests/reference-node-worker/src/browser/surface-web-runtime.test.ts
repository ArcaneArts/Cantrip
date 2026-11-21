import { expect, it, vi } from "vitest";
import type { CantripMcpBinding } from "@cantrip/protocol";
import type { BrowserCdpSession } from "./browser-session.js";
import { BrowserSurfaceWebRuntime } from "./surface-web-runtime.js";

it("stops only the matching turn, releases its held button, and leaves the page reusable", async () => {
  const calls: Record<string, unknown>[] = [];
  const cdp = {
    client: { onClose: vi.fn(() => () => undefined) },
    on: vi.fn(() => () => undefined),
    command: vi.fn(async () => ({})),
    evaluate: vi.fn(async () => ({
      title: "Piano",
      url: "https://example.com",
    })),
    onAgentEnd: vi.fn(),
    agentCommand: vi.fn(async (_identity, _method, params) => {
      calls.push(params);
      return {};
    }),
  } as unknown as BrowserCdpSession;
  const runtime = new BrowserSurfaceWebRuntime({} as never, () => cdp);
  const binding = {
    bindingId: "binding",
    executionLaneId: "new-turn",
    ownerId: "owner",
    chatId: "chat",
  } as CantripMcpBinding;
  const session = await runtime.openSession(binding, "https://example.com", {
    browserTarget: { surfaceId: "surface" } as never,
  });
  const gesture = runtime.pointerSession(binding, {
    sessionId: session.sessionId,
    action: "click",
    x: 5,
    y: 6,
    durationMs: 150_000,
  });
  const rejected = expect(gesture).rejects.toThrow(
    "stopped with its agent turn",
  );
  await vi.waitFor(() =>
    expect(calls.some((call) => call.type === "mousePressed")).toBe(true),
  );
  runtime.cancelBinding({ ...binding, executionLaneId: "old-turn" });
  expect(calls.some((call) => call.type === "mouseReleased")).toBe(false);
  runtime.cancelBinding(binding);
  await rejected;
  expect(calls.map((call) => call.type)).toEqual([
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
  expect(cdp.onAgentEnd).toHaveBeenCalledWith("chat");
  await runtime.pointerSession(
    { ...binding, executionLaneId: "next-turn" },
    { sessionId: session.sessionId, action: "click", x: 7, y: 8 },
  );
  expect(calls.filter((call) => call.type === "mouseReleased")).toHaveLength(2);
});
