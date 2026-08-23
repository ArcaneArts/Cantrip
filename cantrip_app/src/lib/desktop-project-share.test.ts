import { describe, expect, it, vi } from "vitest";

import {
  coordinateDesktopProjectReveal,
  coordinateDesktopProjectRevealPreference,
  directProjectShareUrl,
  desktopFolderRevealLabel,
  desktopProjectRevealButtonLabel,
  desktopProjectRevealLabel,
  nativeLocalProjectFolderRequest,
  nativeProjectShareRequest,
} from "./desktop-project-share";

const project = {
  id: "project-1",
  name: "Cantrip",
  source: {
    displayPath: "ArcaneArts/Cantrip",
    id: "source-1",
    path: "/worker/repositories/ArcaneArts/Cantrip",
    sourceKind: "git",
    workerId: "desktop-worker-1",
  },
} as Parameters<typeof coordinateDesktopProjectReveal>[0];

const attachment = {
  attachmentId: "attachment-1",
  expiresAt: "2026-08-09T12:00:00.000Z",
  mountLeaseMs: 43_200_000,
  password: "a".repeat(24),
  projectId: project.id,
  protocol: "webdav" as const,
  realm: "Cantrip",
  url: "https://cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  username: "cantrip",
};

describe("desktop project reveal", () => {
  it("only offers an operating-system label in desktop macOS and Windows shells", () => {
    expect(desktopProjectRevealLabel(false, "Windows NT 10.0")).toBeNull();
    expect(desktopProjectRevealLabel(true, "iPhone OS 18_0")).toBeNull();
    expect(desktopProjectRevealLabel(true, "X11; Linux x86_64")).toBeNull();
    expect(desktopProjectRevealLabel(true, "Macintosh; Mac OS X 15_5")).toBe(
      "Reveal in Finder",
    );
    expect(desktopProjectRevealLabel(true, "Windows NT 10.0")).toBe(
      "Reveal in File Explorer",
    );
    expect(
      desktopProjectRevealButtonLabel(false, "Macintosh; Mac OS X 15_5"),
    ).toBeNull();
    expect(
      desktopProjectRevealButtonLabel(true, "Macintosh; Mac OS X 15_5"),
    ).toBe("Finder");
    expect(desktopProjectRevealButtonLabel(true, "Windows NT 10.0")).toBe(
      "Explorer",
    );
    expect(desktopFolderRevealLabel(true, "Macintosh; Mac OS X 15_5")).toBe(
      "Show in Finder",
    );
    expect(desktopFolderRevealLabel(true, "Windows NT 10.0")).toBe(
      "Show in File Explorer",
    );
  });

  it("falls back to the network share when the preferred local folder is unavailable", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue(false);
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(true, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).toHaveBeenCalledOnce();
    expect(revealNetworkShare).toHaveBeenCalledOnce();
  });

  it("uses the real folder only when Shift preference resolves locally", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue(true);
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(true, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).toHaveBeenCalledOnce();
    expect(revealNetworkShare).not.toHaveBeenCalled();
  });

  it("opens the network share directly without a local-folder preference", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue(true);
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(false, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).not.toHaveBeenCalled();
    expect(revealNetworkShare).toHaveBeenCalledOnce();
  });

  it("mounts the server-issued attachment without revoking a live mount", async () => {
    const invokeNative = vi.fn().mockResolvedValue(undefined);
    const revokeAttachment = vi.fn().mockResolvedValue(undefined);
    await coordinateDesktopProjectReveal(project, {
      createAttachment: vi.fn().mockResolvedValue(attachment),
      invokeNative,
      revokeAttachment,
    });
    expect(invokeNative).toHaveBeenCalledWith(attachment, project);
    expect(revokeAttachment).not.toHaveBeenCalled();
  });

  it("passes the bounded server mount lease to the native command", () => {
    expect(nativeProjectShareRequest(attachment, project)).toMatchObject({
      attachmentId: attachment.attachmentId,
      directTunnelId: null,
      fallbackUrl: null,
      mountLeaseMs: 43_200_000,
      projectId: project.id,
      projectName: project.name,
      relativePath: "",
    });
  });

  it("binds a local-folder reveal to the active server and source owner", () => {
    expect(
      nativeLocalProjectFolderRequest(project, "https://cantrip.example"),
    ).toEqual({
      folderManagement: null,
      path: "/worker/repositories/ArcaneArts/Cantrip",
      relativePath: "",
      serverUrl: "https://cantrip.example",
      sourceKind: "git",
      workerId: "desktop-worker-1",
    });
  });

  it("marks added folders for direct local path resolution", () => {
    expect(
      nativeLocalProjectFolderRequest(
        {
          ...project,
          folderManagement: "external",
          originKind: "managed-folder",
          source: {
            ...project.source!,
            displayPath: "/Users/example/Documents/notes",
            path: "/Users/example/Documents/notes",
            sourceKind: "folder",
          },
        },
        "https://cantrip.example",
      ),
    ).toEqual({
      folderManagement: "external",
      path: "/Users/example/Documents/notes",
      relativePath: "",
      serverUrl: "https://cantrip.example",
      sourceKind: "folder",
      workerId: "desktop-worker-1",
    });
  });

  it("binds a direct mount to its authoritative server fallback", () => {
    expect(
      nativeProjectShareRequest(attachment, project, {
        fallbackUrl: attachment.url,
        tunnelId: "share-tunnel-1",
      }),
    ).toMatchObject({
      directTunnelId: "share-tunnel-1",
      fallbackUrl: attachment.url,
    });
  });

  it("targets a folder beneath the mounted or local project root", () => {
    expect(
      nativeProjectShareRequest(
        attachment,
        project,
        undefined,
        "src/components/explorer",
      ),
    ).toMatchObject({ relativePath: "src/components/explorer" });
    expect(
      nativeLocalProjectFolderRequest(
        project,
        "https://cantrip.example",
        "src/components/explorer",
      ),
    ).toMatchObject({ relativePath: "src/components/explorer" });
  });

  it("preserves the capability path when mounting a local direct listener", () => {
    expect(directProjectShareUrl(attachment, 41_234)).toBe(
      "http://127.0.0.1:41234/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    );
  });

  it("revokes the attachment while preserving a native mount failure", async () => {
    const failure = new Error("native mount failed");
    const revokeAttachment = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      coordinateDesktopProjectReveal(project, {
        createAttachment: vi.fn().mockResolvedValue(attachment),
        invokeNative: vi.fn().mockRejectedValue(failure),
        revokeAttachment,
      }),
    ).rejects.toBe(failure);
    expect(revokeAttachment).toHaveBeenCalledWith(attachment.attachmentId);
  });
});
