import type {
  CodeAttachment,
  CodeSharedAttachmentWire,
  ExplorerSummary,
} from "@cantrip/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createProtectedExplorerCodeSessionAttachment: vi.fn(),
  getExplorerFile: vi.fn(),
  loadExplorerMedia: vi.fn(),
  releaseProtectedExplorerCodeSessionAttachment: vi.fn(),
  renewProtectedExplorerCodeSessionAttachment: vi.fn(),
  saveExplorerFile: vi.fn(),
}));
const desktopCode = vi.hoisted(() => ({
  directCodeAttachmentHealthyWithin: vi.fn(),
  openDirectCodeAttachmentFile: vi.fn(),
  preferSharedProtectedCodeAttachment: vi.fn(),
  recoverPreferredCodeAttachmentRoute: vi.fn(),
  retainSharedProtectedCodeAttachmentLease: vi.fn(),
  setDirectCodeAttachmentPresentation: vi.fn(),
  stopSharedProtectedCodeAttachment: vi.fn(),
  subscribePreferredCodeAttachmentUnavailable: vi.fn(),
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
const transportId = "44444444-4444-4444-8444-444444444444";
const wire = {
  attachment: {
    formatVersion: 2,
    transport: {
      formatVersion: 2,
      transportId,
      tunnelId: transportId,
      workerId: "worker-one",
      securityScopeId: "55555555-5555-4555-8555-555555555555",
      serverId: "server-one",
      serverControlPlaneGeneration: "66666666-6666-4666-8666-666666666666",
      protectedKeyRevision: 1,
      workerProcessGeneration: "77777777-7777-4777-8777-777777777777",
      expiresAt: attachment.expiresAt,
    },
    session: {
      formatVersion: 2,
      attachmentId: attachment.attachmentId,
      transportId,
      sessionId: attachment.sessionId,
      routeGrant: "route_grant_123456789012345678901234",
      expiresAt: attachment.expiresAt,
      runtime: attachment.runtime,
    },
  } as CodeSharedAttachmentWire,
  binding: {
    identity: {
      accountId: "account-one",
      connectionId: "connection-one",
      generation: 1,
      incarnationId: "88888888-8888-4888-8888-888888888888",
      serverId: "server-one",
      serverUrl: "https://server.example.test",
      userId: "user-one",
    },
    serverUrl: "https://server.example.test",
  },
};
const desktopRouteIdentity = {
  attachmentId: "transport-1",
  diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
  directCapabilityId: "capability-1",
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
    desktopCode.recoverPreferredCodeAttachmentRoute.mockResolvedValue(
      "available",
    );
    api.createProtectedExplorerCodeSessionAttachment.mockResolvedValue(wire);
    desktopCode.preferSharedProtectedCodeAttachment.mockResolvedValue({
      attachment,
      desktopRouteIdentity,
      directTunnelId: transportId,
      sharedOwnedAttachment: wire,
      sharedTransportGeneration: "generation-one",
      transportKind: "local-direct",
    });
    desktopCode.setDirectCodeAttachmentPresentation.mockResolvedValue({
      presentation: "editor",
    });
    desktopCode.openDirectCodeAttachmentFile.mockImplementation(
      async (_attachment, path) => ({ relativePath: path }),
    );
    desktopCode.stopSharedProtectedCodeAttachment.mockResolvedValue(undefined);
    desktopCode.retainSharedProtectedCodeAttachmentLease.mockResolvedValue(
      undefined,
    );
    desktopCode.subscribePreferredCodeAttachmentUnavailable.mockReturnValue(
      () => undefined,
    );
    api.releaseProtectedExplorerCodeSessionAttachment.mockResolvedValue(
      undefined,
    );
    api.renewProtectedExplorerCodeSessionAttachment.mockResolvedValue(wire);
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
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(
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
    desktopCode.stopSharedProtectedCodeAttachment.mockReturnValueOnce(
      stopped.promise,
    );
    client.dispose();
    const disposal = broker.dispose();
    await vi.waitFor(() =>
      expect(
        desktopCode.stopSharedProtectedCodeAttachment,
      ).toHaveBeenCalledWith(wire),
    );
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    stopped.resolve();
    await disposal;
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(wire);
  });

  it("keeps preview-only media out of the protected text editor", async () => {
    const onContext = vi.fn();
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-media",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "assets/photo.png",
    });
    const client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext,
      onEditorEndpoint: vi.fn(),
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    client.editorWorkbenchMounted(frameNonce);
    client.editorWorkbenchReady(frameNonce);

    await broker.ready;
    await vi.waitFor(() => expect(onContext).toHaveBeenCalledOnce());
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(
      "explorer-media",
      null,
      "worker-one",
      "worktree-one",
      "dark",
    );
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    await broker.openFile("assets/next.png", 123_456);
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    client.dispose();
    await broker.dispose();
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
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(
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

  it("retries only the shared transport after one terminal reacquire fails", async () => {
    let terminal!: () => void;
    desktopCode.subscribePreferredCodeAttachmentUnavailable.mockImplementation(
      (_preferred, listener) => {
        terminal = listener;
        return () => undefined;
      },
    );
    const replacementAttachment = {
      ...attachment,
      url: "http://127.0.0.1:43124/code/",
    };
    desktopCode.preferSharedProtectedCodeAttachment
      .mockResolvedValueOnce({
        attachment,
        desktopRouteIdentity,
        directTunnelId: transportId,
        sharedOwnedAttachment: wire,
        sharedTransportGeneration: "generation-one",
        sharedTransportLeaseId: "lease-one",
        transportKind: "local-direct",
      })
      .mockRejectedValueOnce(new TypeError("Transport unavailable"))
      .mockResolvedValueOnce({
        attachment: replacementAttachment,
        desktopRouteIdentity: {
          ...desktopRouteIdentity,
          attachmentId: "transport-2",
        },
        directTunnelId: transportId,
        sharedOwnedAttachment: wire,
        sharedTransportGeneration: "generation-two",
        sharedTransportLeaseId: "lease-two",
        transportKind: "local-direct",
      });
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-terminal-recovery",
          projectId: "project-one",
          worktreeId: "worktree-one",
        } as ExplorerSummary,
        path: "src/index.ts",
      },
      { configureInitialFile: false },
    );
    let endpointCount = 0;
    let client!: DesktopExplorerWindowClient;
    const onEditorError = vi.fn();
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        endpointCount += 1;
        const nonce = `transport_recovery_${endpointCount}_1234567890`;
        client.editorWorkbenchMounted(nonce);
        client.editorWorkbenchReady(nonce);
      },
      onEditorError,
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;
    await vi.waitFor(() =>
      expect(
        desktopCode.subscribePreferredCodeAttachmentUnavailable,
      ).toHaveBeenCalledOnce(),
    );

    terminal();

    await vi.waitFor(() =>
      expect(
        desktopCode.preferSharedProtectedCodeAttachment,
      ).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(onEditorError).toHaveBeenCalled());
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();

    await expect(broker.openFile("src/index.ts")).resolves.toBeUndefined();

    expect(
      desktopCode.retainSharedProtectedCodeAttachmentLease,
    ).toHaveBeenCalledWith(wire, "lease-two");
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledTimes(3);
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    client.dispose();
    await broker.dispose();
  });

  it("requires an explicit retry after one transient file-open failure", async () => {
    desktopCode.setDirectCodeAttachmentPresentation.mockRejectedValueOnce(
      new TypeError("Load failed"),
    );
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

    await expect(broker.ready).rejects.toThrow("Failed to fetch");
    expect(broker.failed).toBe(true);
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledOnce();
    expect(
      desktopCode.recoverPreferredCodeAttachmentRoute,
    ).not.toHaveBeenCalled();
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();

    await expect(broker.openFile("src/recovered.ts")).resolves.toBeUndefined();
    expect(broker.failed).toBe(false);
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(2);
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();

    client.dispose();
    await broker.dispose();
  });

  it("opens the initial file without waiting for presentation", async () => {
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

    await expect(broker.ready).resolves.toBeUndefined();
    expect(broker.failed).toBe(false);
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledOnce();

    client.dispose();
    await broker.dispose();
  });

  it("aborts superseded preparation and releases a delayed result exactly once", async () => {
    const preference = deferred<{
      attachment: CodeAttachment;
      desktopRouteIdentity: typeof desktopRouteIdentity;
      directTunnelId: string;
      sharedOwnedAttachment: typeof wire;
      sharedTransportGeneration: string;
      transportKind: "local-direct";
    }>();
    desktopCode.preferSharedProtectedCodeAttachment.mockReturnValue(
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
      expect(
        desktopCode.preferSharedProtectedCodeAttachment,
      ).toHaveBeenCalledOnce(),
    );
    const preparationSignal = desktopCode.preferSharedProtectedCodeAttachment
      .mock.calls[0]?.[1]?.signal as AbortSignal;
    const ready = expect(broker.ready).rejects.toBeDefined();

    owner.abort(new DOMException("superseded", "AbortError"));
    await broker.dispose();

    expect(preparationSignal.aborted).toBe(true);
    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    preference.resolve({
      attachment,
      desktopRouteIdentity,
      directTunnelId: transportId,
      sharedOwnedAttachment: wire,
      sharedTransportGeneration: "generation-one",
      transportKind: "local-direct",
    });
    await ready;
    await Promise.resolve();
    expect(onEditor).not.toHaveBeenCalled();
    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalled();
    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalledWith(
      wire,
    );
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledTimes(1);

    await broker.dispose();
    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("cleans up late attachment ownership after prompt disposal", async () => {
    const created = deferred<typeof wire>();
    api.createProtectedExplorerCodeSessionAttachment.mockReturnValue(
      created.promise,
    );
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
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();

    created.resolve(wire);
    await ready;
    await vi.waitFor(() =>
      expect(
        api.releaseProtectedExplorerCodeSessionAttachment,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
  });

  it("does not wait for attachment creation that ignores disposal", async () => {
    api.createProtectedExplorerCodeSessionAttachment.mockReturnValue(
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

    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
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
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
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
      expect(
        api.releaseProtectedExplorerCodeSessionAttachment,
      ).toHaveBeenCalledOnce(),
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
      expect(
        api.releaseProtectedExplorerCodeSessionAttachment,
      ).toHaveBeenCalledOnce(),
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

  it("retains one attachment and workbench without idle route probes", async () => {
    vi.useFakeTimers();
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

    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      desktopCode.recoverPreferredCodeAttachmentRoute,
    ).not.toHaveBeenCalled();
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledOnce();
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    expect(endpointCount).toBe(1);

    client.dispose();
    await broker.dispose();
    vi.useRealTimers();
  });

  it("renews the logical session without replacing its shared transport", async () => {
    vi.useFakeTimers();
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker(
      {
        appearance: "dark",
        explorer: {
          activeWorkerId: "worker-one",
          id: "explorer-session-renewal",
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
        client.editorWorkbenchReady(frameNonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(
        api.renewProtectedExplorerCodeSessionAttachment,
      ).toHaveBeenCalledWith(wire, { signal: expect.any(AbortSignal) }),
    );
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledOnce();

    client.dispose();
    await broker.dispose();
    vi.useRealTimers();
  });

  it("keeps the same popout session after a file-open failure", async () => {
    desktopCode.recoverPreferredCodeAttachmentRoute
      .mockReset()
      .mockResolvedValueOnce("replace-required");
    let endpointCount = 0;
    let client!: DesktopExplorerWindowClient;
    const broker = createDesktopExplorerWindowBroker({
      appearance: "dark",
      explorer: {
        activeWorkerId: "worker-one",
        id: "explorer-terminal-route",
        projectId: "project-one",
        worktreeId: "worktree-one",
      } as ExplorerSummary,
      path: "src/current.ts",
    });
    client = new DesktopExplorerWindowClient(broker.launchId, {
      onContext: vi.fn(),
      onEditorEndpoint: () => {
        endpointCount += 1;
        const nonce = `terminal_mount_nonce_${endpointCount}_1234567890`;
        client.editorWorkbenchMounted(nonce);
        client.editorWorkbenchReady(nonce);
      },
      onEditorError: vi.fn(),
      onEditorReady: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await broker.ready;

    desktopCode.openDirectCodeAttachmentFile.mockRejectedValueOnce(
      new TypeError("Load failed"),
    );
    let openFailure: unknown;
    await broker.openFile("src/next.ts").catch((error: unknown) => {
      openFailure = error;
    });

    expect(
      desktopCode.recoverPreferredCodeAttachmentRoute,
    ).not.toHaveBeenCalled();
    expect(openFailure).toBeInstanceOf(Error);
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalled();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    expect(endpointCount).toBe(1);

    await expect(broker.openFile("src/next.ts")).resolves.toBeUndefined();
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(endpointCount).toBe(1);

    client.dispose();
    await broker.dispose();
  });
});
