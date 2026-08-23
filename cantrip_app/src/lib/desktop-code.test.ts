import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAttachment } from "@cantrip/protocol";

const mocks = vi.hoisted(() => ({
  createDirectCodeAttachment: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
  startDirectDesktopTunnel: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@/lib/api", () => ({
  createDirectCodeAttachment: mocks.createDirectCodeAttachment,
  deleteDirectAttachment: vi.fn(),
}));

vi.mock("@/lib/desktop-tunnel", () => ({
  desktopTunnelClientId: vi.fn(() => "desktop-client"),
  startDirectDesktopTunnel: mocks.startDirectDesktopTunnel,
}));

import {
  directCodeAttachmentHealthy,
  openDirectCodeAttachmentFile,
  preferDirectCodeAttachment,
} from "./desktop-code";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { localStorage: {} as Storage });
  mocks.isTauri.mockReturnValue(true);
});

describe("openDirectCodeAttachmentFile", () => {
  it("opens the file through the worker-backed local Code tunnel", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      sessionId: "session-1",
      url: "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as CodeAttachment;
    mocks.fetch.mockResolvedValue({
      json: async () => ({ relativePath: "src/index.ts" }),
      ok: true,
    });

    await expect(
      openDirectCodeAttachmentFile(attachment, "src/index.ts"),
    ).resolves.toEqual({ relativePath: "src/index.ts" });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/open-file"),
      {
        body: JSON.stringify({ relativePath: "src/index.ts" }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  });

  it("surfaces a worker control error", async () => {
    mocks.fetch.mockResolvedValue({
      json: async () => ({ error: "File no longer exists." }),
      ok: false,
    });

    await expect(
      openDirectCodeAttachmentFile(
        {
          url: "http://127.0.0.1:52345/code/",
        } as CodeAttachment,
        "removed.ts",
      ),
    ).rejects.toThrow("File no longer exists.");
  });
});

describe("directCodeAttachmentHealthy", () => {
  it("uses native tunnel state instead of a WebView HTTP fetch", async () => {
    mocks.invoke.mockResolvedValue([
      { tunnelId: "other", routeState: "local-direct" },
      { tunnelId: "code-1", routeState: "local-direct" },
    ]);

    await expect(directCodeAttachmentHealthy("code-1")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("list_tunnel_forwards");
  });

  it("rejects a missing or degraded direct tunnel", async () => {
    mocks.invoke.mockResolvedValue([
      { tunnelId: "code-1", routeState: "degraded" },
    ]);

    await expect(directCodeAttachmentHealthy("code-1")).resolves.toBe(false);
  });
});

describe("preferDirectCodeAttachment", () => {
  it("preserves the workspace query on the local desktop forward", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      sessionId: "session-1",
      url: "http://127.0.0.1:4311/code/relay-token/?workspace=%2Fworker%2Fproject.code-workspace",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as CodeAttachment;
    mocks.createDirectCodeAttachment.mockResolvedValue({
      binding: {
        capabilityId: "capability-1",
        leaseExpiresAt: "2026-08-13T12:00:00.000Z",
      },
    });
    mocks.startDirectDesktopTunnel.mockResolvedValue({
      localHost: "127.0.0.1",
      localPort: 52345,
      tunnelId: "direct-1",
    });

    const preferred = await preferDirectCodeAttachment(attachment);

    expect(preferred.attachment.url).toBe(
      "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    );
    expect(preferred.directTunnelId).toBe("direct-1");
  });
});
