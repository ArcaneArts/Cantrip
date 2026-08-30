import type {
  CodeAppearance,
  CodeAttachment,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";
import {
  createElement,
  startTransition,
  Suspense,
  type ComponentProps,
  type ComponentType,
} from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  CantripApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string | null = null,
    ) {
      super(message);
    }
  },
  createProtectedExplorerCodeAttachment: vi.fn(),
  createProtectedExplorerCodeSessionAttachment: vi.fn(),
  releaseCodeAttachment: vi.fn(),
  releaseProtectedExplorerCodeSessionAttachment: vi.fn(),
  renewProtectedExplorerCodeSessionAttachment: vi.fn(),
}));

const desktopCode = vi.hoisted(() => ({
  openDirectCodeAttachmentFile: vi.fn(),
  preferProtectedCodeAttachment: vi.fn(),
  preferSharedProtectedCodeAttachment: vi.fn(),
  recoverPreferredCodeAttachmentRoute: vi.fn(),
  retainSharedProtectedCodeAttachmentLease: vi.fn(),
  setDirectCodeAttachmentPresentation: vi.fn(),
  setDirectCodeAttachmentTheme: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
  stopSharedProtectedCodeAttachment: vi.fn(),
  subscribePreferredCodeAttachmentUnavailable: vi.fn(),
}));

const tauri = vi.hoisted(() => ({ enabled: false }));

const browserCode = vi.hoisted(() => ({
  bindFrame: vi.fn(() => () => undefined),
  unavailableListeners: new Set<
    (event: { reason: string; tunnelId: string }) => void
  >(),
}));

const frameRuntime = vi.hoisted(() => ({
  mountSequence: 0,
  readyPredicate: null as
    | null
    | ((
        event: MessageEvent<unknown>,
        frameWindow: Window | null,
        mount: { nonce: string; origin: string },
      ) => boolean),
}));

const logging = vi.hoisted(() => ({
  event: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/components/code/code-view", () => ({
  codeWorkbenchFrameClassName: (ready: boolean) =>
    ready ? "frame-ready" : "frame-loading",
  isDarkCodeAppearance: (appearance: CodeAppearance) =>
    appearance === "dark" || appearance.endsWith("-dark"),
}));

vi.mock("@/components/ui/button", async () => {
  const { createElement: createMockElement } = await import("react");
  return {
    Button: ({ children, ...props }: ComponentProps<"button">) =>
      createMockElement("button", props, children),
  };
});

vi.mock("@/lib/api", () => ({
  ...api,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => tauri.enabled,
}));
vi.mock("@/lib/browser-code-tunnel", () => ({
  bindBrowserCodeAttachmentFrame: browserCode.bindFrame,
  subscribeBrowserCodeAttachmentUnavailable: (
    listener: (event: { reason: string; tunnelId: string }) => void,
  ) => {
    browserCode.unavailableListeners.add(listener);
    return () => browserCode.unavailableListeners.delete(listener);
  },
}));
vi.mock("@/lib/code-workbench-frame", () => ({
  CODE_WORKBENCH_READY_TIMEOUT_MS: 15_000,
  CodeWorkbenchFrameLoadTracker: class {
    observe() {
      return false;
    }
  },
  codeWorkbenchStageError: (stage: string, reason?: unknown) =>
    Object.assign(
      new Error(
        reason instanceof Error ? reason.message : String(reason ?? stage),
      ),
      { stage },
    ),
  createCodeWorkbenchFrameMount: (attachmentUrl: string) => {
    const nonce = `frame_nonce_${++frameRuntime.mountSequence}_1234567890`;
    const url = new URL(attachmentUrl);
    url.searchParams.set("cantripFrameNonce", nonce);
    return { nonce, origin: url.origin, url: url.toString() };
  },
  isCodeWorkbenchReadyEvent: (
    event: MessageEvent<unknown>,
    frameWindow: Window | null,
    mount: { nonce: string; origin: string },
  ) => frameRuntime.readyPredicate?.(event, frameWindow, mount) ?? true,
}));
vi.mock("@/lib/desktop-code", () => ({
  ...desktopCode,
  CodeAttachmentHealthError: class extends Error {},
  CodeControlOperationTimeoutError: class extends Error {},
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: logging,
  operationalErrorMetadata: (error: unknown) => ({
    errorClass: error instanceof Error ? error.name : "NonError",
  }),
}));

import {
  EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT,
  ExplorerCodeEditor,
  type ExplorerCodeEditorLifecycleActions,
} from "./explorer-code-editor";
import { deleteExplorerAfterPreparation } from "./explorer-lifecycle";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  sendMessage(event?: unknown): void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Set<(event: unknown) => void>();
  return {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    sendMessage(event = {}) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const now = "2026-08-24T12:00:00.000Z";
const wire = {
  attachmentId: "11111111-1111-4111-8111-111111111111",
  expiresAt: now,
  runtime: {},
  sessionId: "22222222-2222-4222-8222-222222222222",
  tunnelId: "11111111-1111-4111-8111-111111111111",
} as CodeProtectedAttachmentWire;
const attachment = {
  attachmentId: "attachment-1",
  expiresAt: now,
  runtime: {},
  sessionId: wire.sessionId,
  url: "http://127.0.0.1:43123/code/attachment-1/",
} as CodeAttachment;
const sharedTransportId = "44444444-4444-4444-8444-444444444444";
const sharedOwned = {
  attachment: {
    formatVersion: 2,
    transport: {
      formatVersion: 2,
      transportId: sharedTransportId,
      tunnelId: sharedTransportId,
      workerId: "worker-1",
      securityScopeId: "55555555-5555-4555-8555-555555555555",
      serverId: "server-one",
      serverControlPlaneGeneration: "66666666-6666-4666-8666-666666666666",
      protectedKeyRevision: 1,
      workerProcessGeneration: "77777777-7777-4777-8777-777777777777",
      expiresAt: "2026-08-26T12:00:00.000Z",
    },
    session: {
      formatVersion: 2,
      attachmentId: "88888888-8888-4888-8888-888888888888",
      transportId: sharedTransportId,
      sessionId: "99999999-9999-4999-8999-999999999999",
      routeGrant: "route_grant_123456789012345678901234",
      expiresAt: "2026-08-26T12:00:00.000Z",
      runtime: {},
    },
  },
  binding: {
    identity: {
      generation: 1,
      incarnationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      serverId: "server-one",
      serverUrl: "https://server.example.test",
      userId: "user-one",
    },
    serverUrl: "https://server.example.test",
  },
};
const sharedAttachment = {
  ...attachment,
  attachmentId: sharedOwned.attachment.session.attachmentId,
  expiresAt: sharedOwned.attachment.session.expiresAt,
  sessionId: sharedOwned.attachment.session.sessionId,
  url: "http://127.0.0.1:43123/sessions/route_grant_123456789012345678901234/code/",
} as CodeAttachment;

function sharedPreferred(leaseId: string) {
  return {
    attachment: sharedAttachment,
    desktopRouteIdentity: {
      attachmentId: "desktop-forward-one",
      diagnosticTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      directCapabilityId: "capability-one",
    },
    directTunnelId: sharedTransportId,
    sharedOwnedAttachment: sharedOwned,
    sharedTransportGeneration: "transport-generation-one",
    sharedTransportLeaseId: leaseId,
    transportKind: "local-direct" as const,
  };
}

type FutureEditorProps = Omit<
  ComponentProps<typeof ExplorerCodeEditor>,
  "path"
> & {
  path: string | null;
  workerOnline: boolean;
};

const TestExplorerCodeEditor =
  ExplorerCodeEditor as ComponentType<FutureEditorProps>;
const originalWindow = globalThis.window;
let testWindow: FakeWindow;

function editor(
  path: string | null,
  options: {
    active?: boolean;
    appearance?: CodeAppearance;
    explorerId?: string;
    onLifecycleChange?(
      actions: ExplorerCodeEditorLifecycleActions | null,
    ): void;
    onReady?: () => void;
    onWorkbenchReadinessChange?(ready: boolean): void;
    workerId?: string;
    workerOnline?: boolean;
    worktreeId?: string;
  } = {},
) {
  return createElement(TestExplorerCodeEditor, {
    active: options.active ?? true,
    appearance: options.appearance ?? "dark",
    explorerId: options.explorerId ?? "explorer-1",
    onLifecycleChange: options.onLifecycleChange,
    onReady: options.onReady,
    onWorkbenchReadinessChange: options.onWorkbenchReadinessChange,
    path,
    workerId: options.workerId ?? "worker-1",
    workerOnline: options.workerOnline ?? true,
    worktreeId: options.worktreeId ?? "worktree-1",
  });
}

function speculativeEditor(
  path: string | null,
  options: Parameters<typeof editor>[1],
  suspension: Promise<never> | null,
  onSpeculativeRender: () => void,
) {
  const RenderFence = () => {
    onSpeculativeRender();
    if (suspension) throw suspension;
    return null;
  };
  return createElement(
    Suspense,
    { fallback: null },
    editor(path, options),
    createElement(RenderFence),
  );
}

async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function mount(
  path: string | null,
  workerOnline = true,
  onReady?: () => void,
  onLifecycleChange?: (
    actions: ExplorerCodeEditorLifecycleActions | null,
  ) => void,
) {
  const frameWindow = {} as Window;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      editor(path, { onLifecycleChange, onReady, workerOnline }),
      {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      },
    );
  });
  await settle();
  return { frameWindow, renderer };
}

async function flushImmediateTimers() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
  }
}

function emitBrowserUnavailable(tunnelId: string) {
  for (const listener of [...browserCode.unavailableListeners]) {
    listener({ reason: "Relay disconnected.", tunnelId });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  tauri.enabled = false;
  browserCode.unavailableListeners.clear();
  frameRuntime.mountSequence = 0;
  frameRuntime.readyPredicate = null;
  testWindow = fakeWindow();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });
  api.createProtectedExplorerCodeAttachment.mockResolvedValue(wire);
  api.createProtectedExplorerCodeSessionAttachment.mockImplementation(() =>
    tauri.enabled
      ? Promise.resolve(sharedOwned)
      : Promise.reject(
          new api.CantripApiError(
            "Shared transport is unavailable in coordinator mode.",
            409,
            "shared-code-transport-requires-single-server",
          ),
        ),
  );
  api.releaseCodeAttachment.mockResolvedValue(undefined);
  api.releaseProtectedExplorerCodeSessionAttachment.mockResolvedValue(
    undefined,
  );
  api.renewProtectedExplorerCodeSessionAttachment.mockResolvedValue(
    sharedOwned,
  );
  desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
    attachment,
    desktopRouteIdentity: null,
    directTunnelId: null,
    transportKind: "relay",
  });
  desktopCode.preferSharedProtectedCodeAttachment.mockResolvedValue(
    sharedPreferred("lease-one"),
  );
  desktopCode.retainSharedProtectedCodeAttachmentLease.mockResolvedValue(
    undefined,
  );
  desktopCode.recoverPreferredCodeAttachmentRoute.mockResolvedValue(
    "available",
  );
  desktopCode.subscribePreferredCodeAttachmentUnavailable.mockImplementation(
    (_preferred, listener) => {
      const wrapped = () => listener();
      browserCode.unavailableListeners.add(wrapped);
      return () => browserCode.unavailableListeners.delete(wrapped);
    },
  );
  desktopCode.setDirectCodeAttachmentPresentation.mockResolvedValue(undefined);
  desktopCode.setDirectCodeAttachmentTheme.mockResolvedValue(undefined);
  desktopCode.openDirectCodeAttachmentFile.mockImplementation(
    async (_attachment: CodeAttachment, relativePath: string) => ({
      relativePath,
    }),
  );
  desktopCode.stopDirectCodeAttachment.mockResolvedValue(undefined);
  desktopCode.stopSharedProtectedCodeAttachment.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("ExplorerCodeEditor warm lifecycle", () => {
  it("records correlated timings through workbench and file readiness", async () => {
    const { renderer } = await mount("src/timed.ts");

    await act(async () => testWindow.sendMessage());
    await settle();

    const records = logging.event.mock.calls.map(
      ([level, message, context]) => ({ level, message, ...context }),
    );
    const started = records.find(
      (record) => record.event === "code.editor.launch.started",
    );
    expect(started).toMatchObject({
      attachmentReadyAtRequest: false,
      launchKind: "file",
      status: "started",
      workbenchReadyAtRequest: false,
    });
    const launchId = started?.launchId;
    expect(launchId).toEqual(expect.any(String));
    const completedPhases = records
      .filter(
        (record) =>
          record.event === "code.editor.launch.phase" &&
          record.status === "completed" &&
          record.launchId === launchId,
      )
      .map((record) => record.phase);
    expect(completedPhases).toEqual(
      expect.arrayContaining([
        "session-route",
        "transport-ready",
        "workbench-ready",
        "presentation-ready",
        "file-open",
      ]),
    );
    expect(
      records.find(
        (record) =>
          record.event === "code.editor.launch.completed" &&
          record.launchId === launchId,
      ),
    ).toMatchObject({
      attachmentId: attachment.attachmentId,
      durationMs: expect.any(Number),
      sessionId: attachment.sessionId,
      status: "completed",
    });

    await act(async () => renderer.unmount());
  });

  it("quiesces and retires the local lease and session before Explorer deletion", async () => {
    tauri.enabled = true;
    const order: string[] = [];
    let lifecycle: ExplorerCodeEditorLifecycleActions | null = null;
    desktopCode.stopSharedProtectedCodeAttachment.mockImplementation(
      async () => {
        order.push("local-lease-retired");
      },
    );
    api.releaseProtectedExplorerCodeSessionAttachment.mockImplementation(
      async () => {
        order.push("session-released");
      },
    );
    const { renderer } = await mount(
      "src/closing.ts",
      true,
      undefined,
      (actions) => {
        if (actions) lifecycle = actions;
      },
    );
    expect(lifecycle).not.toBeNull();
    expect(renderer.root.findAllByType("iframe")).toHaveLength(1);

    const explorerActions = {
      cancelClose: () => lifecycle?.cancelClose(),
      dirty: false,
      flushViewState: async () => true,
      prepareClose: () => lifecycle?.prepareClose() ?? Promise.resolve(),
      reconcile: async () => undefined,
      save: async () => true,
    };
    let deletion!: Promise<void>;
    await act(async () => {
      deletion = deleteExplorerAfterPreparation(explorerActions, async () => {
        order.push("explorer-delete");
        order.push("server-root-retired");
      });
      await Promise.resolve();
    });
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0);
    await act(async () => deletion);

    expect(order).toEqual([
      "local-lease-retired",
      "session-released",
      "explorer-delete",
      "server-root-retired",
    ]);
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
    await settle();
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
  });

  it("uses the shared logical-session path in a browser when v2 is supported", async () => {
    api.createProtectedExplorerCodeSessionAttachment.mockResolvedValueOnce(
      sharedOwned,
    );

    const { renderer } = await mount("src/browser-shared.ts");

    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(api.createProtectedExplorerCodeAttachment).not.toHaveBeenCalled();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledWith(sharedOwned, { signal: expect.any(AbortSignal) });

    await act(async () => renderer.unmount());
    await settle();

    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalledWith(
      sharedOwned,
    );
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(sharedOwned);
  });

  it("retains the logical session while replacing only an exact failed desktop lease", async () => {
    tauri.enabled = true;
    desktopCode.preferSharedProtectedCodeAttachment
      .mockResolvedValueOnce(sharedPreferred("lease-one"))
      .mockResolvedValueOnce(sharedPreferred("lease-two"));

    const { renderer } = await mount("src/shared.ts");

    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(api.createProtectedExplorerCodeAttachment).not.toHaveBeenCalled();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledWith(sharedOwned, { signal: expect.any(AbortSignal) });

    await act(async () => emitBrowserUnavailable(sharedTransportId));
    await settle();

    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledOnce();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledTimes(2);
    expect(
      desktopCode.retainSharedProtectedCodeAttachmentLease,
    ).toHaveBeenCalledWith(sharedOwned, "lease-two");
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    await settle();

    expect(desktopCode.stopSharedProtectedCodeAttachment).toHaveBeenCalledWith(
      sharedOwned,
    );
    expect(
      api.releaseProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(sharedOwned);
    expect(desktopCode.stopDirectCodeAttachment).not.toHaveBeenCalled();
    expect(api.releaseCodeAttachment).not.toHaveBeenCalled();
  });

  it("does not let an abandoned render alter committed session-open inputs", async () => {
    vi.useFakeTimers();
    const onSpeculativeRender = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        speculativeEditor(
          "src/committed.ts",
          { appearance: "dark", workerOnline: true },
          null,
          onSpeculativeRender,
        ),
        { unstable_isConcurrent: true } as never,
      );
    });
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();

    onSpeculativeRender.mockClear();
    const neverCommits = new Promise<never>(() => undefined);
    await act(async () => {
      startTransition(() => {
        renderer.update(
          speculativeEditor(
            "src/speculative.ts",
            {
              appearance: "light",
              explorerId: "speculative-explorer",
              workerId: "speculative-worker",
              workerOnline: false,
              worktreeId: "speculative-worktree",
            },
            neverCommits,
            onSpeculativeRender,
          ),
        );
      });
      await Promise.resolve();
    });
    expect(onSpeculativeRender).toHaveBeenCalled();

    await flushImmediateTimers();

    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).toHaveBeenCalledWith(
      "explorer-1",
      "src/committed.ts",
      "worker-1",
      "worktree-1",
      "dark",
    );
    await act(async () => renderer.unmount());
  });

  it("does not let an abandoned identity render cancel committed lease recovery", async () => {
    tauri.enabled = true;
    let resolveRecovery!: (value: ReturnType<typeof sharedPreferred>) => void;
    const recovery = new Promise<ReturnType<typeof sharedPreferred>>(
      (resolve) => {
        resolveRecovery = resolve;
      },
    );
    desktopCode.preferSharedProtectedCodeAttachment
      .mockResolvedValueOnce(sharedPreferred("lease-one"))
      .mockImplementationOnce(() => recovery);
    const onSpeculativeRender = vi.fn();
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        speculativeEditor(
          "src/committed.ts",
          { workerOnline: true },
          null,
          onSpeculativeRender,
        ),
        {
          createNodeMock: (element: { type: unknown }) =>
            element.type === "iframe" ? { contentWindow: frameWindow } : null,
          unstable_isConcurrent: true,
        } as never,
      );
    });
    await settle();

    await act(async () => emitBrowserUnavailable(sharedTransportId));
    await settle();
    expect(
      desktopCode.preferSharedProtectedCodeAttachment,
    ).toHaveBeenCalledTimes(2);

    onSpeculativeRender.mockClear();
    const neverCommits = new Promise<never>(() => undefined);
    await act(async () => {
      startTransition(() => {
        renderer.update(
          speculativeEditor(
            "src/speculative.ts",
            {
              explorerId: "speculative-explorer",
              workerId: "speculative-worker",
              worktreeId: "speculative-worktree",
            },
            neverCommits,
            onSpeculativeRender,
          ),
        );
      });
      await Promise.resolve();
    });
    expect(onSpeculativeRender).toHaveBeenCalled();

    await act(async () => {
      resolveRecovery(sharedPreferred("lease-two"));
      await recovery;
    });
    await settle();

    expect(
      desktopCode.retainSharedProtectedCodeAttachmentLease,
    ).toHaveBeenCalledWith(sharedOwned, "lease-two");
    expect(
      desktopCode.stopSharedProtectedCodeAttachment,
    ).not.toHaveBeenCalledWith(sharedOwned, "lease-two");

    await act(async () => renderer.unmount());
  });

  it("reports readiness only after the exact pinned path is open", async () => {
    const onReady = vi.fn();
    const { renderer } = await mount("src/pinned.ts", true, onReady);
    expect(onReady).not.toHaveBeenCalled();

    await act(async () => testWindow.sendMessage());
    await settle();

    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledWith(
      attachment,
      "src/pinned.ts",
      expect.any(Object),
    );
    expect(onReady).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("prewarms without a path, then reuses the attachment and frame for two files", async () => {
    const { frameWindow, renderer } = await mount(null);
    const initialFrame = renderer.root.findByType("iframe");
    const initialFrameUrl = initialFrame.props.src;

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledWith(
      "explorer-1",
      null,
      "worker-1",
      "worktree-1",
      "dark",
    );
    expect(browserCode.bindFrame).toHaveBeenCalledWith(
      attachment.attachmentId,
      frameWindow,
      "frame_nonce_1_1234567890",
    );

    await act(async () => testWindow.sendMessage());
    await settle();

    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(desktopCode.openDirectCodeAttachmentFile).not.toHaveBeenCalled();

    await act(async () => renderer.update(editor("src/first.ts")));
    await settle();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(1);
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenLastCalledWith(
      attachment,
      "src/first.ts",
      expect.any(Object),
    );

    await act(async () => renderer.update(editor("src/second.ts")));
    await settle();
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(2);
    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenLastCalledWith(
      attachment,
      "src/second.ts",
      expect.any(Object),
    );
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(renderer.root.findByType("iframe").props.src).toBe(initialFrameUrl);
    const launchStarts = logging.event.mock.calls
      .map(([, , context]) => context)
      .filter((context) => context.event === "code.editor.launch.started");
    expect(launchStarts).toHaveLength(3);
    expect(launchStarts.map((context) => context.launchKind)).toEqual([
      "prewarm",
      "file",
      "file",
    ]);
    expect(launchStarts.slice(1)).toEqual([
      expect.objectContaining({
        attachmentReadyAtRequest: true,
        workbenchReadyAtRequest: true,
      }),
      expect.objectContaining({
        attachmentReadyAtRequest: true,
        workbenchReadyAtRequest: true,
      }),
    ]);
    expect(
      logging.event.mock.calls.filter(
        ([, , context]) => context.event === "code.editor.launch.completed",
      ),
    ).toHaveLength(3);

    await act(async () => renderer.unmount());
  });

  it("reports exact-generation workbench readiness after prewarm presentation", async () => {
    const onWorkbenchReadinessChange = vi.fn();
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        editor(null, { onWorkbenchReadinessChange }),
        {
          createNodeMock: (element) =>
            element.type === "iframe" ? { contentWindow: frameWindow } : null,
        },
      );
    });
    await settle();
    expect(onWorkbenchReadinessChange).toHaveBeenLastCalledWith(false);

    await act(async () => testWindow.sendMessage());
    await settle();
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(onWorkbenchReadinessChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      renderer.update(editor("src/reused.ts", { onWorkbenchReadinessChange }));
    });
    await settle();
    expect(onWorkbenchReadinessChange).toHaveBeenLastCalledWith(true);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("does not create periodic route probes while a desktop editor is idle", async () => {
    vi.useFakeTimers();
    desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
      attachment,
      desktopRouteIdentity: {
        attachmentId: "desktop-attachment-1",
        diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
        directCapabilityId: "direct-capability-1",
      },
      directTunnelId: wire.tunnelId,
      transportKind: "local-direct",
    });
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor("src/idle.ts"), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      });
    });
    await flushImmediateTimers();
    await act(async () => testWindow.sendMessage());
    await flushImmediateTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(
      desktopCode.recoverPreferredCodeAttachmentRoute,
    ).not.toHaveBeenCalled();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("does not replace the attachment or frame when appearance changes", async () => {
    const { renderer } = await mount("src/first.ts");
    const initialFrame = renderer.root.findByType("iframe");
    const initialFrameUrl = initialFrame.props.src;

    await act(async () =>
      renderer.update(editor("src/first.ts", { appearance: "light" })),
    );
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledOnce();
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledWith(
      attachment,
      "light",
      expect.any(Object),
    );
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(renderer.root.findByType("iframe").props.src).toBe(initialFrameUrl);

    await act(async () => renderer.unmount());
  });

  it("keeps theme delivery failures non-blocking and non-destructive", async () => {
    desktopCode.setDirectCodeAttachmentTheme.mockRejectedValue(
      new TypeError("Load failed"),
    );
    const { renderer } = await mount("src/first.ts");
    const initialFrame = renderer.root.findByType("iframe");

    await act(async () =>
      renderer.update(editor("src/first.ts", { appearance: "light" })),
    );
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("replays a failed theme once when the worker returns online", async () => {
    const { renderer } = await mount("src/first.ts");
    const initialFrame = renderer.root.findByType("iframe");
    desktopCode.setDirectCodeAttachmentTheme.mockRejectedValue(
      new TypeError("Load failed"),
    );

    await act(async () =>
      renderer.update(
        editor("src/first.ts", { appearance: "light", workerOnline: false }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await settle();
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledTimes(2);

    desktopCode.setDirectCodeAttachmentTheme.mockResolvedValue(undefined);
    await act(async () =>
      renderer.update(
        editor("src/first.ts", { appearance: "light", workerOnline: true }),
      ),
    );
    await settle();

    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledTimes(3);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);

    await act(async () => renderer.unmount());
  });

  it("does not lose an online edge while a theme retry is in flight", async () => {
    let rejectSecondAttempt!: (error: Error) => void;
    const secondAttempt = new Promise<void>((_resolve, reject) => {
      rejectSecondAttempt = reject;
    });
    const { renderer } = await mount("src/first.ts");
    desktopCode.setDirectCodeAttachmentTheme
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockImplementationOnce(() => secondAttempt)
      .mockResolvedValue(undefined);

    await act(async () =>
      renderer.update(
        editor("src/first.ts", { appearance: "light", workerOnline: false }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledTimes(2);

    await act(async () =>
      renderer.update(
        editor("src/first.ts", { appearance: "light", workerOnline: true }),
      ),
    );
    await settle();
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledTimes(3);

    await act(async () => {
      rejectSecondAttempt(new TypeError("Late offline failure"));
      await Promise.resolve();
    });
    await settle();
    expect(desktopCode.setDirectCodeAttachmentTheme).toHaveBeenCalledTimes(3);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("retries exactly once when the worker returns online after initial failure", async () => {
    api.createProtectedExplorerCodeAttachment
      .mockRejectedValueOnce(new Error("Worker is offline."))
      .mockResolvedValueOnce(wire);
    const { renderer } = await mount("src/first.ts", true);

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: false })),
    );
    await settle();
    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: false })),
    );
    await settle();
    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () => renderer.unmount());
  });

  it("retries a transient initial attachment failure while the worker stays online", async () => {
    api.createProtectedExplorerCodeAttachment
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(wire);
    const { renderer } = await mount(null, true);

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("iframe")).toBeDefined();

    await act(async () => renderer.unmount());
  });

  it("consumes a pending attachment cooldown on the first path activation", async () => {
    api.createProtectedExplorerCodeAttachment
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(wire);
    const { renderer } = await mount(null, true);

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    await act(async () => renderer.update(editor("src/first.ts")));
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("iframe")).toBeDefined();

    await act(async () => renderer.unmount());
  });

  it("retries pathless presentation on the same attachment and frame", async () => {
    desktopCode.setDirectCodeAttachmentPresentation
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(undefined);
    const { renderer } = await mount(null, true);
    const initialFrame = renderer.root.findByType("iframe");
    const initialFrameUrl = initialFrame.props.src;

    await act(async () => testWindow.sendMessage());
    await settle();
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await settle();

    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledTimes(2);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(renderer.root.findByType("iframe").props.src).toBe(initialFrameUrl);

    await act(async () => renderer.unmount());
  });

  it("retries workbench document readiness with a new nonce on the same attachment", async () => {
    vi.useFakeTimers();
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      });
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      });
    }
    const initialFrame = renderer.root.findByType("iframe");
    const initialFrameUrl = initialFrame.props.src;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_500);
      await Promise.resolve();
    });

    const retriedFrame = renderer.root.findByType("iframe");
    expect(retriedFrame.props.src).not.toBe(initialFrameUrl);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => testWindow.sendMessage());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("accepts exact workbench readiness at 14.5 seconds on the original frame", async () => {
    vi.useFakeTimers();
    frameRuntime.readyPredicate = (event, frameWindow, mount) =>
      frameWindow !== null &&
      event.source === frameWindow &&
      event.origin === mount.origin &&
      (event.data as { nonce?: string } | null)?.nonce === mount.nonce;
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      });
    });
    await flushImmediateTimers();
    const initialFrameUrl = renderer.root.findByType("iframe").props
      .src as string;
    const initialMount = new URL(initialFrameUrl);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_500);
      testWindow.sendMessage({
        data: { nonce: initialMount.searchParams.get("cantripFrameNonce") },
        origin: initialMount.origin,
        source: frameWindow,
      });
      await Promise.resolve();
    });
    await flushImmediateTimers();

    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe").props.src).toBe(initialFrameUrl);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("ignores readiness at 15.1 seconds and accepts only the replacement nonce", async () => {
    vi.useFakeTimers();
    frameRuntime.readyPredicate = (event, frameWindow, mount) =>
      frameWindow !== null &&
      event.source === frameWindow &&
      event.origin === mount.origin &&
      (event.data as { nonce?: string } | null)?.nonce === mount.nonce;
    const frameWindow = {} as Window;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      });
    });
    await flushImmediateTimers();
    const initialFrameUrl = renderer.root.findByType("iframe").props
      .src as string;
    const initialMount = new URL(initialFrameUrl);
    const staleReadyEvent = {
      data: { nonce: initialMount.searchParams.get("cantripFrameNonce") },
      origin: initialMount.origin,
      source: frameWindow,
    };

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
      testWindow.sendMessage(staleReadyEvent);
      await Promise.resolve();
    });
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await Promise.resolve();
    });
    const replacementFrameUrl = renderer.root.findByType("iframe").props
      .src as string;
    const replacementMount = new URL(replacementFrameUrl);
    expect(replacementFrameUrl).not.toBe(initialFrameUrl);

    await act(async () => {
      testWindow.sendMessage(staleReadyEvent);
      await Promise.resolve();
    });
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).not.toHaveBeenCalled();

    await act(async () => {
      testWindow.sendMessage({
        data: {
          nonce: replacementMount.searchParams.get("cantripFrameNonce"),
        },
        origin: replacementMount.origin,
        source: frameWindow,
      });
      await Promise.resolve();
    });
    await flushImmediateTimers();

    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledOnce();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("caps workbench document retries across timer and visibility wakes", async () => {
    vi.useFakeTimers();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: {} as Window } : null,
      });
    });
    await flushImmediateTimers();

    await act(async () => renderer.root.findByType("iframe").props.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushImmediateTimers();
    for (
      let attempt = 1;
      attempt < EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      await act(async () => renderer.root.findByType("iframe").props.onError());
      await act(async () => renderer.update(editor(null, { active: false })));
      await act(async () => renderer.update(editor(null, { active: true })));
      await flushImmediateTimers();
    }

    const exhaustedFrameUrl = renderer.root.findByType("iframe").props.src;
    await act(async () => renderer.root.findByType("iframe").props.onError());
    await act(async () => renderer.update(editor(null, { active: false })));
    await act(async () => renderer.update(editor(null, { active: true })));
    await flushImmediateTimers();

    expect(renderer.root.findByType("iframe").props.src).toBe(
      exhaustedFrameUrl,
    );
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("caps navigation retries across timer and worker-online wakes", async () => {
    vi.useFakeTimers();
    desktopCode.setDirectCodeAttachmentPresentation.mockRejectedValue(
      new TypeError("Load failed"),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: {} as Window } : null,
      });
    });
    await flushImmediateTimers();
    await act(async () => testWindow.sendMessage());
    await flushImmediateTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushImmediateTimers();
    for (
      let attempt = 1;
      attempt < EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      await act(async () =>
        renderer.update(editor(null, { workerOnline: false })),
      );
      await act(async () =>
        renderer.update(editor(null, { workerOnline: true })),
      );
      await flushImmediateTimers();
    }
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledTimes(EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1);

    await act(async () =>
      renderer.update(editor(null, { workerOnline: false })),
    );
    await act(async () =>
      renderer.update(editor(null, { workerOnline: true })),
    );
    await flushImmediateTimers();
    expect(
      desktopCode.setDirectCodeAttachmentPresentation,
    ).toHaveBeenCalledTimes(EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("retries file open after the bridge reconnects without replacing the attachment", async () => {
    desktopCode.openDirectCodeAttachmentFile
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockImplementationOnce(
        async (_attachment: CodeAttachment, relativePath: string) => ({
          relativePath,
        }),
      );
    const { renderer } = await mount("src/first.ts", true);
    const initialFrame = renderer.root.findByType("iframe");

    await act(async () => testWindow.sendMessage());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await settle();

    expect(desktopCode.openDirectCodeAttachmentFile).toHaveBeenCalledTimes(4);
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);

    await act(async () => renderer.unmount());
  });

  it("recovers a failed unavailable replacement after its cooldown", async () => {
    api.createProtectedExplorerCodeAttachment
      .mockResolvedValueOnce(wire)
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(wire);
    desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
      attachment,
      desktopRouteIdentity: null,
      directTunnelId: wire.tunnelId,
      transportKind: "relay",
    });
    const { renderer } = await mount(null, true);

    await act(async () => emitBrowserUnavailable(wire.tunnelId));
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(3);
    expect(renderer.root.findByType("iframe")).toBeDefined();

    await act(async () => renderer.unmount());
  });

  it("caps automatic attachment replacement until the workbench is ready", async () => {
    vi.useFakeTimers();
    const createdWires: CodeProtectedAttachmentWire[] = [];
    api.createProtectedExplorerCodeAttachment.mockImplementation(async () => {
      const sequence = createdWires.length + 1;
      const createdWire = {
        ...wire,
        attachmentId: `attachment-wire-${sequence}`,
        tunnelId: `tunnel-${sequence}`,
      } as CodeProtectedAttachmentWire;
      createdWires.push(createdWire);
      return createdWire;
    });
    desktopCode.preferProtectedCodeAttachment.mockImplementation(
      async (createdWire: CodeProtectedAttachmentWire) => ({
        attachment: {
          ...attachment,
          attachmentId: createdWire.attachmentId,
          url: `http://127.0.0.1:43123/code/${createdWire.attachmentId}/`,
        },
        desktopRouteIdentity: null,
        directTunnelId: createdWire.tunnelId,
        transportKind: "relay",
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: {} as Window } : null,
      });
    });
    await flushImmediateTimers();

    for (
      let attempt = 0;
      attempt < EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      await act(async () =>
        emitBrowserUnavailable(createdWires.at(-1)!.tunnelId),
      );
      await flushImmediateTimers();
    }
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    await act(async () =>
      emitBrowserUnavailable(createdWires.at(-1)!.tunnelId),
    );
    await flushImmediateTimers();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    await act(async () => testWindow.sendMessage());
    await flushImmediateTimers();
    await act(async () =>
      emitBrowserUnavailable(createdWires.at(-1)!.tunnelId),
    );
    await flushImmediateTimers();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 2,
    );

    await act(async () => renderer.unmount());
  });

  it("lets explicit Retry reset an exhausted attachment replacement budget", async () => {
    vi.useFakeTimers();
    const createdWires: CodeProtectedAttachmentWire[] = [];
    api.createProtectedExplorerCodeAttachment.mockImplementation(async () => {
      const sequence = createdWires.length + 1;
      const createdWire = {
        ...wire,
        attachmentId: `manual-attachment-wire-${sequence}`,
        tunnelId: `manual-tunnel-${sequence}`,
      } as CodeProtectedAttachmentWire;
      createdWires.push(createdWire);
      return createdWire;
    });
    desktopCode.preferProtectedCodeAttachment.mockImplementation(
      async (createdWire: CodeProtectedAttachmentWire) => ({
        attachment: {
          ...attachment,
          attachmentId: createdWire.attachmentId,
          url: `http://127.0.0.1:43123/code/${createdWire.attachmentId}/`,
        },
        desktopRouteIdentity: null,
        directTunnelId: createdWire.tunnelId,
        transportKind: "relay",
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null), {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: {} as Window } : null,
      });
    });
    await flushImmediateTimers();

    for (
      let attempt = 0;
      attempt <= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      await act(async () =>
        emitBrowserUnavailable(createdWires.at(-1)!.tunnelId),
      );
      await flushImmediateTimers();
    }
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    await act(async () => renderer.root.findByType("button").props.onClick());
    await flushImmediateTimers();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 2,
    );

    await act(async () => renderer.unmount());
  });

  it("consumes a failed hidden replacement cooldown on visibility", async () => {
    api.createProtectedExplorerCodeAttachment
      .mockResolvedValueOnce(wire)
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(wire);
    desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
      attachment,
      desktopRouteIdentity: null,
      directTunnelId: wire.tunnelId,
      transportKind: "relay",
    });
    const { renderer } = await mount("src/first.ts", true);

    await act(async () =>
      renderer.update(editor("src/first.ts", { active: false })),
    );
    await act(async () => emitBrowserUnavailable(wire.tunnelId));
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () =>
      renderer.update(editor("src/first.ts", { active: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(3);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(3);

    await act(async () => renderer.unmount());
  });

  it("connects once when an initially offline worker first comes online", async () => {
    const { renderer } = await mount("src/first.ts", false);

    expect(api.createProtectedExplorerCodeAttachment).not.toHaveBeenCalled();

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("consumes an online retry edge after an in-flight connection fails", async () => {
    let rejectFirstConnection!: (error: Error) => void;
    api.createProtectedExplorerCodeAttachment
      .mockImplementationOnce(
        () =>
          new Promise<CodeProtectedAttachmentWire>((_resolve, reject) => {
            rejectFirstConnection = reject;
          }),
      )
      .mockResolvedValueOnce(wire);
    const { renderer } = await mount("src/first.ts", true);

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: false })),
    );
    await settle();
    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => {
      rejectFirstConnection(new Error("Worker disconnected during attach."));
      await Promise.resolve();
    });
    await settle();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () =>
      renderer.update(editor("src/first.ts", { workerOnline: true })),
    );
    await settle();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(2);

    await act(async () => renderer.unmount());
  });

  it("caps pending in-flight retries across repeated worker-online flaps", async () => {
    vi.useFakeTimers();
    const rejectConnections: Array<(error: Error) => void> = [];
    api.createProtectedExplorerCodeAttachment.mockImplementation(
      () =>
        new Promise<CodeProtectedAttachmentWire>((_resolve, reject) => {
          rejectConnections.push(reject);
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor("src/first.ts"));
    });
    await flushImmediateTimers();

    for (
      let attempt = 0;
      attempt <= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      expect(rejectConnections[attempt]).toBeDefined();
      await act(async () =>
        renderer.update(
          editor("src/first.ts", {
            workerOnline: false,
          }),
        ),
      );
      await act(async () =>
        renderer.update(
          editor("src/first.ts", {
            workerOnline: true,
          }),
        ),
      );
      await act(async () => {
        rejectConnections[attempt]!(new TypeError("Load failed"));
        await Promise.resolve();
      });
      await flushImmediateTimers();
    }

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );
    for (let flap = 0; flap < 3; flap += 1) {
      await act(async () =>
        renderer.update(
          editor("src/first.ts", {
            workerOnline: false,
          }),
        ),
      );
      await act(async () =>
        renderer.update(
          editor("src/first.ts", {
            workerOnline: true,
          }),
        ),
      );
      await flushImmediateTimers();
    }
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    await act(async () => renderer.unmount());
  });

  it("shares one retry budget across timers and activation edges until manual reload", async () => {
    vi.useFakeTimers();
    api.createProtectedExplorerCodeAttachment.mockRejectedValue(
      new TypeError("Load failed"),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(editor(null));
    });
    await flushImmediateTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushImmediateTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushImmediateTimers();
    for (
      let attempt = 2;
      attempt < EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
      attempt += 1
    ) {
      await act(async () => renderer.update(editor(null, { active: false })));
      await act(async () => renderer.update(editor(null, { active: true })));
      await flushImmediateTimers();
    }
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    await act(async () => renderer.update(editor("src/first.ts")));
    await act(async () =>
      renderer.update(
        editor("src/first.ts", {
          active: false,
        }),
      ),
    );
    await act(async () =>
      renderer.update(
        editor("src/first.ts", {
          active: true,
        }),
      ),
    );
    await act(async () =>
      renderer.update(
        editor("src/first.ts", {
          workerOnline: false,
        }),
      ),
    );
    await act(async () =>
      renderer.update(
        editor("src/first.ts", {
          workerOnline: true,
        }),
      ),
    );
    await flushImmediateTimers();
    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 1,
    );

    api.createProtectedExplorerCodeAttachment.mockResolvedValueOnce(wire);
    await act(async () => renderer.root.findByType("button").props.onClick());
    await flushImmediateTimers();

    expect(api.createProtectedExplorerCodeAttachment).toHaveBeenCalledTimes(
      EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT + 2,
    );
    expect(renderer.root.findByType("iframe")).toBeDefined();

    await act(async () => renderer.unmount());
  });
});
