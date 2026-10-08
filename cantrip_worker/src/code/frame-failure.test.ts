import type { ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { writeCodeWorkbenchFrameFailure } from "./frame-failure.js";

function responseFixture() {
  const response = {
    headersSent: false,
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  return { response, serverResponse: response as unknown as ServerResponse };
}

describe("Code workbench HTTP failure documents", () => {
  const nonce = "failed_frame_nonce_123456";
  const request = { method: "GET", url: `/code/?cantripFrameNonce=${nonce}` };

  it.each([400, 404, 502, 503, 599])(
    "preserves HTTP %s and reports it from the failed document",
    (statusCode) => {
      const { response, serverResponse } = responseFixture();
      expect(
        writeCodeWorkbenchFrameFailure(
          request,
          serverResponse,
          "/code",
          statusCode,
        ),
      ).toBe(true);
      expect(response.writeHead).toHaveBeenCalledWith(statusCode, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`,
        "x-content-type-options": "nosniff",
      });
      const body = String(response.end.mock.calls[0]?.[0]);
      const script = body.match(
        /<script nonce="[^"]+">([\s\S]*)<\/script>/u,
      )?.[1];
      expect(script).toBeDefined();
      const postMessage = vi.fn();
      runInNewContext(script!, { window: { parent: { postMessage } } });
      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        {
          type: "cantrip-code.frame-load-failed",
          version: 1,
          nonce,
          statusCode,
        },
        "*",
      );
    },
  );

  it.each([
    { ...request, method: "POST" },
    { ...request, method: "HEAD" },
    { ...request, url: "/code/" },
    { ...request, url: "/code/?cantripFrameNonce=short" },
    {
      ...request,
      url: `/code/?cantripFrameNonce=${nonce}&cantripFrameNonce=${nonce}`,
    },
    {
      ...request,
      url: `/code/?cantripFrameNonce=${encodeURIComponent("<script>alert(1)</script>")}`,
    },
    { ...request, url: `/code/asset.js?cantripFrameNonce=${nonce}` },
    { ...request, url: `/code/_cantrip/health?cantripFrameNonce=${nonce}` },
    { ...request, url: "http://[" },
  ])(
    "does not rewrite an unmounted or non-document request: $url ($method)",
    (input) => {
      const { response, serverResponse } = responseFixture();
      expect(
        writeCodeWorkbenchFrameFailure(input, serverResponse, "/code", 503),
      ).toBe(false);
      expect(response.writeHead).not.toHaveBeenCalled();
      expect(response.end).not.toHaveBeenCalled();
    },
  );

  it.each([200, 302, 399, 600, 503.5])(
    "does not treat HTTP %s as a failed document response",
    (statusCode) => {
      const { response, serverResponse } = responseFixture();
      expect(
        writeCodeWorkbenchFrameFailure(
          request,
          serverResponse,
          "/code",
          statusCode,
        ),
      ).toBe(false);
      expect(response.end).not.toHaveBeenCalled();
    },
  );

  it("does not replace a response after its headers were sent", () => {
    const { response, serverResponse } = responseFixture();
    response.headersSent = true;
    expect(
      writeCodeWorkbenchFrameFailure(request, serverResponse, "/code", 503),
    ).toBe(false);
    expect(response.end).not.toHaveBeenCalled();
  });
});
