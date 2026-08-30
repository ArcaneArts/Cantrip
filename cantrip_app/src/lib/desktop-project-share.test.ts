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
    placementMode: "managed",
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
  url: "http://127.0.0.1/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
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

  it.each([
    ["worker-not-local", "worker is not running on this desktop"],
    ["server-mismatch", "connected to a different Cantrip server"],
    ["source-path-missing", "no longer exists"],
    ["outside-managed-root", "outside this worker's managed storage root"],
    ["explorer-launch-failed", "file manager could not open"],
  ] as const)(
    "reports the %s local reveal result without falling back to a network share",
    async (result, message) => {
      const revealLocalFolder = vi.fn().mockResolvedValue(result);
      const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

      await expect(
        coordinateDesktopProjectRevealPreference(true, {
          revealLocalFolder,
          revealNetworkShare,
        }),
      ).rejects.toThrow(message);

      expect(revealLocalFolder).toHaveBeenCalledOnce();
      expect(revealNetworkShare).not.toHaveBeenCalled();
    },
  );

  it("uses the real folder only when Shift preference resolves locally", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue("opened");
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(true, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).toHaveBeenCalledOnce();
    expect(revealNetworkShare).not.toHaveBeenCalled();
  });

  it("uses the local worker path automatically when this desktop owns it", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue("opened");
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(false, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).toHaveBeenCalledOnce();
    expect(revealNetworkShare).not.toHaveBeenCalled();
  });

  it("falls back to the network share when the worker is remote", async () => {
    const revealLocalFolder = vi.fn().mockResolvedValue("worker-not-local");
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(false, {
      revealLocalFolder,
      revealNetworkShare,
    });

    expect(revealLocalFolder).toHaveBeenCalledOnce();
    expect(revealNetworkShare).toHaveBeenCalledOnce();
  });

  it("falls back to the network share when the local bridge fails", async () => {
    const revealLocalFolder = vi.fn().mockRejectedValue(new Error("offline"));
    const revealNetworkShare = vi.fn().mockResolvedValue(undefined);

    await coordinateDesktopProjectRevealPreference(false, {
      revealLocalFolder,
      revealNetworkShare,
    });

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
      placementMode: "managed",
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
      placementMode: "managed",
      relativePath: "",
      serverUrl: "https://cantrip.example",
      sourceKind: "folder",
      workerId: "desktop-worker-1",
    });
  });

  it("marks directly placed repositories for local path resolution", () => {
    expect(
      nativeLocalProjectFolderRequest(
        {
          ...project,
          source: {
            ...project.source!,
            displayPath: "D:\\Projects\\Cantrip",
            path: "D:\\Projects\\Cantrip",
            placementMode: "direct",
          },
        },
        "https://cantrip.example",
      ),
    ).toMatchObject({
      path: "D:\\Projects\\Cantrip",
      placementMode: "direct",
      sourceKind: "git",
    });
  });

  it("targets files and folders beneath the mounted or local project root", () => {
    expect(
      nativeProjectShareRequest(attachment, project, "src/components/explorer"),
    ).toMatchObject({ relativePath: "src/components/explorer" });
    expect(
      nativeLocalProjectFolderRequest(
        project,
        "https://cantrip.example",
        "src/components/explorer",
      ),
    ).toMatchObject({ relativePath: "src/components/explorer" });
    expect(
      nativeProjectShareRequest(attachment, project, "src/main.ts"),
    ).toMatchObject({ relativePath: "src/main.ts" });
    expect(
      nativeLocalProjectFolderRequest(
        project,
        "https://cantrip.example",
        "src/main.ts",
      ),
    ).toMatchObject({ relativePath: "src/main.ts" });
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
