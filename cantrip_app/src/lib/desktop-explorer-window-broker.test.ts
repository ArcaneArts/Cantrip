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
  directCodeAttachmentHealthyWithin: vi.fn(),
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
const frameNonce = "mount_nonce_1234567890";

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
    desktopCode.directCodeAttachmentHealthyWithin.mockResolvedValue(true);
    api.createProtectedExplorerCodeAttachment.mockResolvedValue(wire);
    desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
      attachment,
      directTunnelId: wire.tunnelId,
    });
    desktopCode.setDirectCodeAttachmentPresentation.mockResolvedValue({
      presentation: "editor",
    });
    desktopCode.openDirectCodeAttachmentFile.mockImplementation(
      async (_attachment, path) => ({ relativePath: path }),
    );
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
      onEditorEndpoint: resolveEditor,
      onEditorError: vi.fn(),
      onEditorReady: resolveConfigured,
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(editor).resolves.toEqual(attachment);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledWith(
      "explorer-one",
      "src/index.ts",
      "worker-one",
      "worktree-one",
      "dark",
    );
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    client.editorWorkbenchMounted(frameNonce);
    client.editorWorkbenchReady(frameNonce);
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

    const stopped = deferred<void>();
    desktopCode.stopDirectCodeAttachment.mockReturnValueOnce(stopped.promise);
    client.dispose();
    const disposal = broker.dispose();
    await vi.waitFor(() =>
      expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledWith(
        wire.tunnelId,
      ),
    );
    expect(api.releaseCodeAttachment).not.toHaveBeenCalled();
    stopped.resolve();
    await disposal;
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
      { configureInitialFile: false },
    );
    const onConfigured = vi.fn();
    let client!: DesktopExplorerWindowClient;
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: vi.fn(),
      onEditorError: vi.fn(),
      onEditorReady: onConfigured,
      onLaunchError: vi.fn(),
    });
    client.start();
    client.editorWorkbenchMounted(frameNonce);
    client.editorWorkbenchReady(frameNonce);

    await broker.ready;
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledWith(
      "explorer-warm",
      null,
      "worker-one",
      "worktree-one",
      "dark",
    );
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
      onEditorEndpoint: () => {
        client.editorWorkbenchMounted(frameNonce);
        client.editorWorkbenchReady(frameNonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
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
      onEditorEndpoint: () => {
        client.editorWorkbenchMounted(frameNonce);
        client.editorWorkbenchReady(frameNonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
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
        signal: owner.signal,
      },
    );
    const onEditor = vi.fn();
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: onEditor,
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
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

  it("never treats a failed iframe document as editor readiness", async () => {
    const onEditorError = vi.fn();
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-error-document",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false },
    );
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        client.editorWorkbenchMounted(frameNonce);
        client.editorWorkbenchFailed(
          frameNonce,
          "The embedded document returned an error page.",
          "frame",
        );
      },
      onEditorError,
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(broker.ready).rejects.toThrow("error page");
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(api.releaseCodeAttachment).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(onEditorError).toHaveBeenCalledWith(
        expect.stringContaining("error page"),
        "frame",
      ),
    );

    client.dispose();
    await broker.dispose();
  });

  it("bounds workbench readiness and releases a frame that never acknowledges", async () => {
    vi.useFakeTimers();
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-frame-timeout",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: ".cantrip-editor-prewarm",
      },
      { configureInitialFile: false },
    );
    const ready = expect(broker.ready).rejects.toThrow(
      "workbench did not become ready",
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    await ready;
    await vi.waitFor(() =>
      expect(api.releaseCodeAttachment).toHaveBeenCalledOnce(),
    );
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();

    await broker.dispose();
    vi.useRealTimers();
  });

  it("coalesces rapid file switches onto the final exact path", async () => {
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-rapid",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/initial.ts",
    });
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        client.editorWorkbenchMounted(frameNonce);
        client.editorWorkbenchReady(frameNonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;
    desktopCode.openDirectCodeAttachmentFile.mockClear();

    await Promise.all([
      broker.openFile("src/a.ts", 10),
      broker.openFile("src/b.ts", 20),
      broker.openFile("src/c.ts", 30),
    ]);

    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/c.ts",
      { signal: expect.any(AbortSignal) },
    );

    client.dispose();
    await broker.dispose();
  });

  it("replays presentation and the current file for a newly mounted frame", async () => {
    const secondNonce = "replacement_nonce_1234567890";
    const onEditorReady = vi.fn();
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-frame-reload",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/current.ts",
    });
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        client.editorWorkbenchMounted(frameNonce);
        client.editorWorkbenchReady(frameNonce);
      },
      onEditorError: vi.fn(),
      onEditorReady,
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;
    await vi.waitFor(() => expect(onEditorReady).toHaveBeenCalledOnce());

    client.editorWorkbenchMounted(secondNonce);
    client.editorWorkbenchFailed(frameNonce, "stale frame failed", "frame");
    expect(broker.failed).toBe(false);
    client.editorWorkbenchReady(secondNonce);

    await vi.waitFor(() =>
      expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(2),
    );
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(onEditorReady).toHaveBeenCalledTimes(2));

    client.dispose();
    await broker.dispose();
  });

  it("replaces an unhealthy attachment and replays the current file", async () => {
    vi.useFakeTimers();
    const replacementWire = {
      ...wire,
      attachmentId: "33333333-3333-4333-8333-333333333333",
      tunnelId: "44444444-4444-4444-8444-444444444444",
    };
    api.createProtectedExplorerCodeAttachment
      .mockResolvedValueOnce(wire)
      .mockResolvedValueOnce(replacementWire);
    desktopCode.preferProtectedCodeAttachment.mockImplementation(
      async (selectedWire) => ({
        attachment: {
          ...attachment,
          attachmentId: selectedWire.attachmentId,
          url: `http://127.0.0.1:43123/code/${selectedWire.attachmentId}/`,
        },
        directTunnelId: selectedWire.tunnelId,
      }),
    );
    desktopCode.directCodeAttachmentHealthyWithin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    let endpointCount = 0;
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-health-recovery",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/current.ts",
    });
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        endpointCount += 1;
        const nonce = `health_mount_nonce_${endpointCount}_1234567890`;
        client.editorWorkbenchMounted(nonce);
        client.editorWorkbenchReady(nonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(2),
    );
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();
    expect(endpointCount).toBe(2);

    client.dispose();
    await broker.dispose();
    vi.useRealTimers();
  });
});
