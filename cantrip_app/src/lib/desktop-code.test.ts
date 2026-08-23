import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAttachment } from "@cantrip/protocol";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  startDesktopTunnel: vi.fn(),
  stopDesktopTunnel: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@/lib/desktop-tunnel", () => ({
  startDesktopTunnel: mocks.startDesktopTunnel,
  stopDesktopTunnel: mocks.stopDesktopTunnel,
}));

vi.mock("@/lib/browser-code-tunnel", () => ({
  browserCodeAttachmentHealthy: vi.fn(),
  startBrowserCodeAttachment: vi.fn(),
  stopBrowserCodeAttachment: vi.fn(),
}));

import {
  directCodeAttachmentHealthy,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  setDirectCodeAttachmentPresentation,
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

describe("setDirectCodeAttachmentPresentation", () => {
  it("switches the local compatibility session into editor-only mode", async () => {
    const attachment = {
      url: "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    } as CodeAttachment;
    mocks.fetch.mockResolvedValue({
      json: async () => ({ presentation: "editor" }),
      ok: true,
    });

    await expect(
      setDirectCodeAttachmentPresentation(attachment, "editor"),
    ).resolves.toEqual({ presentation: "editor" });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/presentation"),
      {
        body: JSON.stringify({ presentation: "editor" }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
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

describe("preferProtectedCodeAttachment", () => {
  it("opens the protected generic tunnel at the worker-local Code path", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });

    const preferred = await preferProtectedCodeAttachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {
        workspaceUri: "file:///worker/project.code-workspace",
      },
    } as never);

    expect(preferred.attachment.url).toBe(
      "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    );
    expect(preferred.directTunnelId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
