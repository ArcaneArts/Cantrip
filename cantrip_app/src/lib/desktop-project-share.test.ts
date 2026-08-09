import { describe, expect, it, vi } from "vitest";

import {
  coordinateDesktopProjectReveal,
  desktopProjectRevealLabel,
} from "./desktop-project-share";

const project = {
  id: "project-1",
  name: "Cantrip",
} as Parameters<typeof coordinateDesktopProjectReveal>[0];

const attachment = {
  attachmentId: "attachment-1",
  expiresAt: "2026-08-09T12:00:00.000Z",
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
