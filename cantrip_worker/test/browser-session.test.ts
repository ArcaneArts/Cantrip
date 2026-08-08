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
