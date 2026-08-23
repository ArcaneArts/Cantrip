import type { CodeAttachment, ExplorerSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { CantripApiError } from "./api-client";

const api = vi.hoisted(() => ({
  createCodeAttachment: vi.fn(),
  createCodeTab: vi.fn(),
  createExplorerCodeAttachment: vi.fn(),
  deleteCodeTab: vi.fn(),
  getExplorerFile: vi.fn(),
  getInternalExplorerEditorCodeTabs: vi.fn(),
  loadExplorerMedia: vi.fn(),
  openCodeAttachmentFile: vi.fn(),
  releaseCodeAttachment: vi.fn(),
  saveExplorerFile: vi.fn(),
}));
const desktopCode = vi.hoisted(() => ({
  openDirectCodeAttachmentFile: vi.fn(),
  preferDirectCodeAttachment: vi.fn(),
  setDirectCodeAttachmentPresentation: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/desktop-code", () => desktopCode);

import { createDesktopExplorerWindowBroker } from "./desktop-explorer-window-broker";
import { DesktopExplorerWindowClient } from "./desktop-explorer-window-client";

describe("desktop Explorer window broker", () => {
  it("hands the iframe URL to the child before waiting for its workbench bridge", async () => {
    const attachment = {
      attachmentId: "attachment-one",
      url: "http://127.0.0.1:43123/code/",
    } as CodeAttachment;
    api.getInternalExplorerEditorCodeTabs.mockResolvedValue([
      { id: "stale-code-tab" },
    ]);
    api.createExplorerCodeAttachment.mockRejectedValue(
      new CantripApiError("Not Found", 404),
    );
    api.createCodeTab.mockResolvedValue({ id: "code-tab-one" });
    api.createCodeAttachment.mockResolvedValue(attachment);
    api.deleteCodeTab.mockResolvedValue(undefined);
    desktopCode.preferDirectCodeAttachment.mockResolvedValue({
      attachment,
      directTunnelId: "direct-code:session-one",
    });
    desktopCode.setDirectCodeAttachmentPresentation.mockReturnValue(
      new Promise(() => undefined),
    );
    desktopCode.stopDirectCodeAttachment.mockResolvedValue(undefined);

    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        id: "explorer-one",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/index.ts",
    });
    let resolveEditor!: (value: CodeAttachment) => void;
    const editor = new Promise<CodeAttachment>((resolve) => {
      resolveEditor = resolve;
    });
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: resolveEditor,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(editor).resolves.toEqual(attachment);
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    client.dispose();
    await broker.dispose();
    expect(api.deleteCodeTab).toHaveBeenCalledWith("stale-code-tab");
    expect(api.deleteCodeTab).toHaveBeenCalledWith("code-tab-one");
  });
});
