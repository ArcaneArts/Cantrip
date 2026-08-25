import type {
  CodeAppearance,
  CodeAttachment,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";
import { createElement, type ComponentProps, type ComponentType } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createProtectedExplorerCodeAttachment: vi.fn(),
  releaseCodeAttachment: vi.fn(),
}));

const desktopCode = vi.hoisted(() => ({
  openDirectCodeAttachmentFile: vi.fn(),
  preferProtectedCodeAttachment: vi.fn(),
  recoverPreferredCodeAttachmentRoute: vi.fn(),
  setDirectCodeAttachmentPresentation: vi.fn(),
  setDirectCodeAttachmentTheme: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
  subscribePreferredCodeAttachmentUnavailable: vi.fn(),
}));

const browserCode = vi.hoisted(() => ({
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
  CantripApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/browser-code-tunnel", () => ({
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

import {
  EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT,
  ExplorerCodeEditor,
} from "./explorer-code-editor";

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
    onReady?: () => void;
    workerOnline?: boolean;
  } = {},
) {
  return createElement(TestExplorerCodeEditor, {
    active: options.active ?? true,
    appearance: options.appearance ?? "dark",
    explorerId: "explorer-1",
    onReady: options.onReady,
    path,
    workerId: "worker-1",
    workerOnline: options.workerOnline ?? true,
    worktreeId: "worktree-1",
  });
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
) {
  const frameWindow = {} as Window;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(editor(path, { onReady, workerOnline }), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
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
  browserCode.unavailableListeners.clear();
  frameRuntime.mountSequence = 0;
  frameRuntime.readyPredicate = null;
  testWindow = fakeWindow();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });
  api.createProtectedExplorerCodeAttachment.mockResolvedValue(wire);
  api.releaseCodeAttachment.mockResolvedValue(undefined);
  desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
    attachment,
    desktopRouteIdentity: null,
    directTunnelId: null,
    transportKind: "relay",
  });
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
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("ExplorerCodeEditor warm lifecycle", () => {
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
    const { renderer } = await mount(null);
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
      await vi.advanceTimersByTimeAsync(60_000);
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
