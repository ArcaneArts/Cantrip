import { describe, expect, it, vi } from "vitest";
import type { ProjectSurface } from "@/lib/project-surface";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { pinProjectSurface } from "./project-surface-pin";

const surface = {
  kind: "file",
  preview: true,
  projectId: "project",
  tabKey: "view",
  tabId: "document",
} as ProjectSurface;
function workspace() {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  return {
    controller: {
      dispatch,
      getSnapshot: () => ({ authoritative: { projectId: "project" } }),
    } as unknown as WorkspaceCommandClient,
    dispatch,
  };
}
describe("pinProjectSurface", () => {
  it("pins the view identity without promoting or replacing the document", async () => {
    const owner = workspace();
    await pinProjectSurface(owner, surface);
    expect(owner.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "pin",
      tabId: "view",
    });
    expect(surface.preview).toBe(true);
  });
  it.each([false, undefined])(
    "ignores already pinned files with preview=%s",
    async (preview) => {
      const owner = workspace();
      await pinProjectSurface(owner, { ...surface, preview });
      expect(owner.dispatch).not.toHaveBeenCalled();
    },
  );
  it("does not pin non-file resources", async () => {
    const owner = workspace();
    await pinProjectSurface(owner, {
      ...surface,
      kind: "chat",
    } as ProjectSurface);
    expect(owner.dispatch).not.toHaveBeenCalled();
  });
  it("reports unavailable or wrong project ownership without a legacy write", async () => {
    await expect(pinProjectSurface(null, surface)).rejects.toThrow("not ready");
    const owner = workspace();
    await expect(
      pinProjectSurface(owner, { ...surface, projectId: "other" }),
    ).rejects.toThrow("another project");
    expect(owner.dispatch).not.toHaveBeenCalled();
  });
  it("propagates actual command failure and leaves the preview retryable", async () => {
    const owner = workspace();
    owner.dispatch.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(pinProjectSurface(owner, surface)).rejects.toThrow(
      "Connection lost",
    );
    expect(surface.preview).toBe(true);
    await pinProjectSurface(owner, surface);
    expect(owner.dispatch).toHaveBeenCalledTimes(2);
  });
});
