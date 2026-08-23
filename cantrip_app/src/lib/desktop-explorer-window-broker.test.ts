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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

describe("desktop Explorer window broker", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
    api.releaseCodeAttachment.mockResolvedValue(undefined);
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
    let client!: DesktopExplorerWindowClient;
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: resolveEditor,
      onEditorConfigured: resolveConfigured,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(editor).resolves.toEqual(attachment);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    client.editorFrameLoaded();
    await vi.waitFor(() =>
      expect(
        desktopCode.setDirectCodeAttachmentPresentation,
      ).toHaveBeenCalledOnce(),
    );
    finishPresentation();
    await expect(configured).resolves.toEqual(expect.any(Number));
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/index.ts",
      { signal: expect.any(AbortSignal) },
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
    let client!: DesktopExplorerWindowClient;
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: vi.fn(),
      onEditorConfigured: onConfigured,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    client.editorFrameLoaded();

    await broker.ready;
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();
    await broker.openFile("src/warm.ts", 123_456);
    await vi.waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/warm.ts",
      { signal: expect.any(AbortSignal) },
    );

    client.dispose();
    await broker.dispose();
  });

  it("recovers transient control failures without poisoning the editor broker", async () => {
    desktopCode.setDirectCodeAttachmentPresentation
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ presentation: "editor" });
    desktopCode.openDirectCodeAttachmentFile
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ relativePath: "src/recovered.ts" });
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-recovery",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/recovered.ts",
    });
    let client!: DesktopExplorerWindowClient;
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: () => client.editorFrameLoaded(),
      onEditorConfigured: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(broker.ready).resolves.toBeUndefined();
    expect(broker.failed).toBe(false);
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledTimes(2);
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(2);

    client.dispose();
    await broker.dispose();
  });

  it("marks a broker unavailable after non-transient startup failure", async () => {
    desktopCode.setDirectCodeAttachmentPresentation.mockRejectedValueOnce(
      new Error("Workbench rejected the request."),
    );
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-failed",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/failed.ts",
    });
    let client!: DesktopExplorerWindowClient;
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor: () => client.editorFrameLoaded(),
      onEditorConfigured: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(broker.ready).rejects.toThrow(
      "Workbench rejected the request.",
    );
    expect(broker.failed).toBe(true);

    client.dispose();
    await broker.dispose();
  });

  it("aborts superseded preparation and releases a delayed result exactly once", async () => {
    const preference = deferred<{
      attachment: CodeAttachment;
      directTunnelId: string;
    }>();
    desktopCode.preferProtectedCodeAttachment.mockReturnValue(
      preference.promise,
    );
    const owner = new AbortController();
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-superseded",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      {
        configureInitialFile: false,
        requireDirectBridge: true,
        signal: owner.signal,
      },
    );
    const onEditor = vi.fn();
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditor,
      onEditorConfigured: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await vi.waitFor(() =>
      expect(desktopCode.preferProtectedCodeAttachment).toHaveBeenCalledOnce(),
    );
    const preparationSignal = desktopCode.preferProtectedCodeAttachment.mock
      .calls[0]?.[1]?.signal as AbortSignal;
    const ready = expect(broker.ready).rejects.toBeDefined();

    owner.abort(new DOMException("superseded", "AbortError"));
    await broker.dispose();

    expect(preparationSignal.aborted).toBe(true);
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();
    preference.resolve({ attachment, directTunnelId: wire.tunnelId });
    await ready;
    await Promise.resolve();
    expect(onEditor).not.toHaveBeenCalled();
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledTimes(1);
    expect(api.releaseCodeAttachment).toHaveBeenCalledTimes(1);

    await broker.dispose();
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledTimes(1);
    expect(api.releaseCodeAttachment).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("cleans up late attachment ownership after prompt disposal", async () => {
    const created = deferred<typeof wire>();
    api.createProtectedExplorerCodeAttachment.mockReturnValue(created.promise);
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-delayed-create",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false },
    );
    const ready = expect(broker.ready).rejects.toBeDefined();
    await expect(broker.dispose()).resolves.toBeUndefined();
    expect(desktopCode.stopDirectCodeAttachment).not.toHaveBeenCalled();
    expect(api.releaseCodeAttachment).not.toHaveBeenCalled();

    created.resolve(wire);
    await ready;
    await vi.waitFor(() =>
      expect(api.releaseCodeAttachment).toHaveBeenCalledOnce(),
    );
    expect(desktopCode.preferProtectedCodeAttachment).not.toHaveBeenCalled();
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();
  });

  it("does not wait for attachment creation that ignores disposal", async () => {
    api.createProtectedExplorerCodeAttachment.mockReturnValue(
      new Promise(() => undefined),
    );
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-stuck-create",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false },
    );
    const ready = expect(broker.ready).rejects.toBeDefined();

    await expect(broker.dispose()).resolves.toBeUndefined();
    await ready;

    expect(desktopCode.stopDirectCodeAttachment).not.toHaveBeenCalled();
    expect(api.releaseCodeAttachment).not.toHaveBeenCalled();
  });

  it("does not create an attachment for an already superseded owner", async () => {
    const owner = new AbortController();
    owner.abort(new DOMException("superseded", "AbortError"));

    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-already-superseded",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false, signal: owner.signal },
    );

    await expect(broker.ready).rejects.toBe(owner.signal.reason);
    await expect(broker.dispose()).resolves.toBeUndefined();
    expect(api.createProtectedExplorerCodeAttachment).not.toHaveBeenCalled();
    expect(desktopCode.preferProtectedCodeAttachment).not.toHaveBeenCalled();
  });
});
