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
}));

const frameRuntime = vi.hoisted(() => ({
  mountSequence: 0,
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

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/browser-code-tunnel", () => ({
  subscribeBrowserCodeAttachmentUnavailable: () => () => undefined,
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
  isCodeWorkbenchReadyEvent: () => true,
}));
vi.mock("@/lib/desktop-code", () => ({
  ...desktopCode,
  CodeControlOperationTimeoutError: class extends Error {},
}));

import { ExplorerCodeEditor } from "./explorer-code-editor";

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
    appearance?: CodeAppearance;
    workerOnline?: boolean;
  } = {},
) {
  return createElement(TestExplorerCodeEditor, {
    appearance: options.appearance ?? "dark",
    explorerId: "explorer-1",
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

async function mount(path: string | null, workerOnline = true) {
  const frameWindow = {} as Window;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(editor(path, { workerOnline }), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
  await settle();
  return { frameWindow, renderer };
}

beforeEach(() => {
  vi.clearAllMocks();
  frameRuntime.mountSequence = 0;
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
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("ExplorerCodeEditor warm lifecycle", () => {
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
});
