import type { CodeAttachment, ExplorerSummary } from "@cantrip/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createProtectedExplorerCodeAttachment: vi.fn(),
  getExplorerFile: vi.fn(),
  loadExplorerMedia: vi.fn(),
  releaseCodeAttachment: vi.fn(),
  saveExplorerFile: vi.fn(),
}));
const desktopCode = vi.hoisted(() => ({
  openDirectCodeAttachmentFile: vi.fn(),
  preferProtectedCodeAttachment: vi.fn(),
  setDirectCodeAttachmentPresentation: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/desktop-code", () => desktopCode);

import { createDesktopExplorerWindowBroker } from "./desktop-explorer-window-broker";
import { DesktopExplorerWindowClient } from "./desktop-explorer-window-client";

const attachment = {
  attachmentId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  url: "http://127.0.0.1:43123/code/",
  expiresAt: "2026-08-13T12:00:00.000Z",
  runtime: {},
} as CodeAttachment;
const wire = {
  attachmentId: attachment.attachmentId,
  tunnelId: attachment.attachmentId,
  sessionId: attachment.sessionId,
  expiresAt: attachment.expiresAt,
  runtime: attachment.runtime,
};

describe("desktop Explorer window broker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createProtectedExplorerCodeAttachment.mockResolvedValue(wire);
    desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
      attachment,
      directTunnelId: wire.tunnelId,
    });
    desktopCode.setDirectCodeAttachmentPresentation.mockResolvedValue({
      presentation: "editor",
    });
    desktopCode.openDirectCodeAttachmentFile.mockResolvedValue({
      relativePath: "src/index.ts",
    });
    desktopCode.stopDirectCodeAttachment.mockResolvedValue(undefined);
  });

  it("configures the protected workbench before announcing the initial file", async () => {
    let finishPresentation!: () => void;
    desktopCode.setDirectCodeAttachmentPresentation.mockReturnValue(
      new Promise<void>((resolve) => {
        finishPresentation = resolve;
      }),
    );
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
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
    let resolveConfigured!: (value: number) => void;
    const configured = new Promise<number>((resolve) => {
      resolveConfigured = resolve;
    });
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: resolveEditor,
      onEditorConfigured: resolveConfigured,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(editor).resolves.toEqual(attachment);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    finishPresentation();
    await expect(configured).resolves.toEqual(expect.any(Number));
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/index.ts",
    );

    client.dispose();
    await broker.dispose();
    expect(api.releaseCodeAttachment).toHaveBeenCalledWith(
      attachment.attachmentId,
    );
  });

  it("reuses the protected workbench for later file navigation", async () => {
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-warm",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false, requireDirectBridge: true },
    );
    const onConfigured = vi.fn();
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: vi.fn(),
      onEditorConfigured: onConfigured,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await broker.ready;
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();
    await broker.openFile("src/warm.ts", 123_456);
    await vi.waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/warm.ts",
    );

    client.dispose();
    await broker.dispose();
  });
});
