import { describe, expect, it, vi } from "vitest";

import { BrowserCdpSession } from "../src/browser/browser-session.js";
import type { CdpClient } from "../src/browser/cdp-client.js";

describe("BrowserCdpSession", () => {
  it("keeps future DOM and screenshot tooling bound to one target session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ result: { value: "Cantrip" } })
      .mockResolvedValueOnce({ data: "jpeg" })
      .mockResolvedValueOnce({
        documents: [],
        layout: {},
        strings: [],
      });
    const client = { request } as unknown as CdpClient;
    const session = new BrowserCdpSession(client, "cdp-session-1");

    await expect(session.evaluate<string>("document.title")).resolves.toBe(
      "Cantrip",
    );
    await expect(session.captureScreenshot()).resolves.toEqual({
      data: "jpeg",
    });
    await expect(session.captureDomSnapshot()).resolves.toMatchObject({
      documents: [],
    });
    expect(
      request.mock.calls.every((call) => call[2] === "cdp-session-1"),
    ).toBe(true);
  });
});

it("publishes only agent pointer dispatches without awaiting presentation or changing CDP order", async () => {
  const request = vi.fn().mockResolvedValue({});
  const session = new BrowserCdpSession(
    { request } as unknown as CdpClient,
    "one-target",
  );
  const observe = vi.fn(() => {
    throw new Error("overlay unavailable");
  });
  session.onAgentPointer = observe;
  await session.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 1,
    y: 2,
  });
  expect(observe).not.toHaveBeenCalled();
  await session.agentCommand("agent", "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 3,
    y: 4,
    buttons: 1,
  });
  await session.agentCommand("agent", "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 5,
    y: 6,
    buttons: 1,
  });
  expect(observe).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map((call) => call[1].x)).toEqual([1, 3, 5]);
  expect(request.mock.calls.every((call) => call[2] === "one-target")).toBe(
    true,
  );
});

it("retains the dispatched click state while its acknowledgement is pending", async () => {
  let acknowledge!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const session = new BrowserCdpSession(
    { request } as unknown as CdpClient,
    "target",
  );
  const observe = vi.fn();
  session.onAgentPointer = observe;
  const params = { type: "mousePressed", x: 3, y: 4, buttons: 1 };
  const pending = session.agentCommand(
    "agent",
    "Input.dispatchMouseEvent",
    params,
  );
  Object.assign(params, { type: "mouseReleased", x: 8, y: 9, buttons: 0 });
  acknowledge({});
  await pending;
  expect(observe).toHaveBeenCalledWith({
    identity: "agent",
    x: 3,
    y: 4,
    click: true,
    dragging: true,
  });
});
