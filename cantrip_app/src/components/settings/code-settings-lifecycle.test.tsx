import type {
  CodeAttachment,
  CodeSettingsWorkerStatus,
  CodeSettingsWorkbenchAttachmentWire,
  WorkerSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createProtectedCodeSettingsAttachment: vi.fn(),
  getCodeSettingsWorkerStatus: vi.fn(),
  getWorkers: vi.fn(),
  releaseCodeAttachment: vi.fn(),
  resolveCodeSettingsWorker: vi.fn(),
  synchronizeCodeSettingsWorker: vi.fn(),
}));

const desktopCode = vi.hoisted(() => ({
  directCodeAttachmentHealthyWithin: vi.fn(),
  openDirectCodeAttachmentExtensions: vi.fn(),
  openDirectCodeAttachmentSettings: vi.fn(),
  preferProtectedCodeAttachment: vi.fn(),
  recoverPreferredCodeAttachmentRoute: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
  subscribePreferredCodeAttachmentUnavailable: vi.fn(),
}));
const availability = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
}));
const browserCode = vi.hoisted(() => ({
  bindFrame: vi.fn(() => () => undefined),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/browser-code-tunnel", () => ({
  bindBrowserCodeAttachmentFrame: browserCode.bindFrame,
}));
vi.mock("@/lib/desktop-code", () => desktopCode);
vi.mock("@/lib/app-live-react", () => ({
  useAppLiveStatus: () => "stopped",
}));

import { CodeSettings } from "./code-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-08-23T12:00:00.000Z";
const readyStatus: CodeSettingsWorkerStatus = {
  profileId: "default",
  state: "ready",
  revision: 1,
  conflictCount: 0,
  initializedFromWorker: true,
  backupCreated: false,
  lastSynchronizedAt: now,
  error: null,
};
const conflictStatus: CodeSettingsWorkerStatus = {
  ...readyStatus,
  state: "conflict",
  revision: 2,
  conflictCount: 2,
  initializedFromWorker: false,
};
const worker = {
  workerId: "worker-1",
  name: "Local Worker",
  online: true,
  code: { available: true },
  encryption: {
    supported: true,
    state: "ready",
    grants: [{ component: "customization-content", keyRevision: 1 }],
  },
} as WorkerSummary;
const secondWorker = {
  ...worker,
  workerId: "worker-2",
  name: "Remote Worker",
} as WorkerSummary;
const attachment = {
  attachmentId: "attachment-1",
  sessionId: "session-1",
  url: "http://127.0.0.1:43123/code/attachment-1/",
  expiresAt: "2026-08-23T13:00:00.000Z",
  runtime: {},
} as CodeAttachment;
const wire = {
  workerId: worker.workerId,
  synchronization: readyStatus,
  attachment: {
    attachmentId: attachment.attachmentId,
    tunnelId: "11111111-1111-4111-8111-111111111111",
    sessionId: attachment.sessionId,
    expiresAt: attachment.expiresAt,
    runtime: {},
  },
} as CodeSettingsWorkbenchAttachmentWire;

interface FakeWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  sendMessage(event: unknown): void;
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
    sendMessage(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function mount(active = true) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const frameWindow = {} as Window;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CodeSettings, {
          active,
          appearance: "dark",
          defaultWorkerId: worker.workerId,
        }),
      ),
      {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      },
    );
  });
  await settle();
  return { frameWindow, queryClient, renderer };
}

function readyEvent(
  renderer: TestRenderer.ReactTestRenderer,
  frameWindow: Window,
) {
  const iframe = renderer.root.findByType("iframe");
  const url = new URL(iframe.props.src as string);
  return {
    data: {
      type: "cantrip-code.workbench-ready",
      version: 1,
      nonce: url.searchParams.get("cantripFrameNonce"),
    },
    origin: url.origin,
    source: frameWindow,
  };
}

function updateActive(
  renderer: TestRenderer.ReactTestRenderer,
  queryClient: QueryClient,
  active: boolean,
) {
  renderer.update(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CodeSettings, {
        active,
        appearance: "dark",
        defaultWorkerId: worker.workerId,
      }),
    ),
  );
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

const originalWindow = globalThis.window;

beforeEach(() => {
  vi.clearAllMocks();
  availability.listeners.clear();
  const testWindow = fakeWindow();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });
  api.getWorkers.mockResolvedValue([worker]);
  api.getCodeSettingsWorkerStatus.mockResolvedValue(readyStatus);
  api.createProtectedCodeSettingsAttachment.mockResolvedValue(wire);
  api.releaseCodeAttachment.mockResolvedValue(undefined);
  api.resolveCodeSettingsWorker.mockResolvedValue(conflictStatus);
  api.synchronizeCodeSettingsWorker.mockResolvedValue(readyStatus);
  desktopCode.preferProtectedCodeAttachment.mockResolvedValue({
    attachment,
    directTunnelId: null,
  });
  desktopCode.recoverPreferredCodeAttachmentRoute.mockResolvedValue(
    "available",
  );
  desktopCode.subscribePreferredCodeAttachmentUnavailable.mockImplementation(
    (_preferred, listener) => {
      availability.listeners.add(listener);
      return () => availability.listeners.delete(listener);
    },
  );
  desktopCode.openDirectCodeAttachmentSettings.mockResolvedValue({
    opened: true,
  });
  desktopCode.openDirectCodeAttachmentExtensions.mockResolvedValue({
    opened: true,
  });
  desktopCode.stopDirectCodeAttachment.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("CodeSettings retained workbench lifecycle", () => {
  it("clearly reports when no compatible worker is available", async () => {
    api.getWorkers.mockResolvedValue([]);

    const { renderer } = await mount();

    expect(renderedText(renderer)).toContain(
      "No compatible Code worker is available",
    );
    expect(renderedText(renderer)).toContain(
      "Connect an encryption-capable worker with Cantrip Code installed.",
    );
    expect(api.createProtectedCodeSettingsAttachment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "offline",
      "Cantrip Server is temporarily unavailable.",
      "Cantrip Server is temporarily unavailable.",
    ],
    ["uninitialized", null, "Code settings are uninitialized."],
    [
      "error",
      "Encrypted settings could not be authenticated.",
      "Encrypted settings could not be authenticated.",
    ],
  ] as const)(
    "renders the %s synchronization state",
    async (state, error, expected) => {
      const synchronization: CodeSettingsWorkerStatus = {
        ...readyStatus,
        state,
        revision: state === "uninitialized" ? null : readyStatus.revision,
        initializedFromWorker: false,
        error,
      };
      api.createProtectedCodeSettingsAttachment.mockResolvedValue({
        ...wire,
        synchronization,
      });

      const { renderer } = await mount();

      expect(renderedText(renderer)).toContain("Code settings could not open");
      expect(renderedText(renderer)).toContain(expected);
    },
  );

  it("creates once when mounted and retains the iframe while active toggles", async () => {
    const { frameWindow, queryClient, renderer } = await mount(true);
    const initialFrame = renderer.root.findByType("iframe");

    expect(browserCode.bindFrame).toHaveBeenCalledWith(
      attachment.attachmentId,
      frameWindow,
      expect.any(String),
    );
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();

    await act(async () => updateActive(renderer, queryClient, false));
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("section").props["aria-hidden"]).toBe(true);

    await act(async () => updateActive(renderer, queryClient, true));
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("replaces the attachment when its exact transport reports terminal", async () => {
    const { renderer } = await mount(true);
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();

    await act(async () => {
      for (const listener of [...availability.listeners]) listener();
    });
    await settle();

    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledTimes(2);
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("waits for the authenticated frame-ready event and gates interaction on the acknowledgement", async () => {
    const opening = deferred<{ opened: true }>();
    desktopCode.openDirectCodeAttachmentSettings.mockReturnValue(
      opening.promise,
    );
    const { frameWindow, renderer } = await mount(true);
    let iframe = renderer.root.findByType("iframe");

    expect(desktopCode.openDirectCodeAttachmentSettings).not.toHaveBeenCalled();
    expect(iframe.props["aria-hidden"]).toBe(true);
    expect(iframe.props.tabIndex).toBe(-1);

    await act(async () => {
      (window as unknown as FakeWindow).sendMessage({
        ...readyEvent(renderer, frameWindow),
        origin: "http://127.0.0.1:9999",
      });
    });
    expect(desktopCode.openDirectCodeAttachmentSettings).not.toHaveBeenCalled();

    await act(async () => {
      (window as unknown as FakeWindow).sendMessage(
        readyEvent(renderer, frameWindow),
      );
    });
    expect(desktopCode.openDirectCodeAttachmentSettings).toHaveBeenCalledWith(
      attachment,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    iframe = renderer.root.findByType("iframe");
    expect(iframe.props["aria-hidden"]).toBe(true);
    expect(iframe.props.tabIndex).toBe(-1);

    await act(async () => opening.resolve({ opened: true }));
    iframe = renderer.root.findByType("iframe");
    expect(iframe.props["aria-hidden"]).toBe(false);
    expect(iframe.props.tabIndex).toBe(0);

    await act(async () => renderer.unmount());
  });

  it("switches native customization views without replacing the retained iframe", async () => {
    const { frameWindow, renderer } = await mount(true);
    const initialFrame = renderer.root.findByType("iframe");

    await act(async () => {
      (window as unknown as FakeWindow).sendMessage(
        readyEvent(renderer, frameWindow),
      );
    });
    await settle();
    expect(desktopCode.openDirectCodeAttachmentSettings).toHaveBeenCalledOnce();

    const extensionsTab = renderer.root
      .findAllByType("button")
      .find(
        (button) =>
          button.props.role === "tab" && button.children.includes("Extensions"),
      );
    expect(extensionsTab).toBeDefined();
    await act(async () => extensionsTab!.props.onClick());
    await settle();

    expect(desktopCode.openDirectCodeAttachmentExtensions).toHaveBeenCalledWith(
      attachment,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(renderer.root.findByType("iframe")).toBe(initialFrame);
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();
    expect(renderedText(renderer)).toContain("filesystem and process access");

    const settingsTab = renderer.root
      .findAllByType("button")
      .find(
        (button) =>
          button.props.role === "tab" && button.children.includes("Settings"),
      );
    await act(async () => settingsTab!.props.onClick());
    await settle();
    expect(desktopCode.openDirectCodeAttachmentSettings).toHaveBeenCalledTimes(
      2,
    );
    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("uses the visible worker selector to replace the worker-local attachment", async () => {
    api.getWorkers.mockResolvedValue([worker, secondWorker]);
    api.createProtectedCodeSettingsAttachment.mockImplementation(
      async (workerId: string) => ({ ...wire, workerId }),
    );
    const { renderer } = await mount(true);
    const selector = renderer.root.findByProps({
      "aria-label": "Code customization worker",
    });

    expect(selector.props.value).toBe(worker.workerId);
    await act(async () =>
      selector.props.onChange({ target: { value: secondWorker.workerId } }),
    );
    await settle();

    expect(api.createProtectedCodeSettingsAttachment).toHaveBeenLastCalledWith(
      secondWorker.workerId,
      "dark",
    );
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it("retires the local tunnel and server attachment exactly once", async () => {
    const { renderer } = await mount(true);

    await act(async () => renderer.unmount());
    await settle();

    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledOnce();
    expect(desktopCode.stopDirectCodeAttachment).toHaveBeenCalledWith(
      wire.attachment,
    );
    expect(api.releaseCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).toHaveBeenCalledWith(
      wire.attachment.attachmentId,
    );
  });

  it("maps both conflict decisions to the selected worker", async () => {
    api.getCodeSettingsWorkerStatus.mockResolvedValue(conflictStatus);
    api.createProtectedCodeSettingsAttachment.mockResolvedValue({
      ...wire,
      synchronization: conflictStatus,
    });
    const { renderer } = await mount(true);
    const button = (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((candidate) => candidate.children.includes(label))!;

    await act(async () => button("Use synced settings").props.onClick());
    await settle();
    expect(api.resolveCodeSettingsWorker).toHaveBeenCalledWith(
      worker.workerId,
      "accept-canonical",
    );

    await act(async () =>
      button("Keep this worker’s settings").props.onClick(),
    );
    await settle();
    expect(api.resolveCodeSettingsWorker).toHaveBeenCalledWith(
      worker.workerId,
      "publish-local",
    );

    await act(async () => renderer.unmount());
  });

  it("keeps Extensions usable while encrypted Settings are conflicted", async () => {
    api.getCodeSettingsWorkerStatus.mockResolvedValue(conflictStatus);
    api.createProtectedCodeSettingsAttachment.mockResolvedValue({
      ...wire,
      synchronization: conflictStatus,
    });
    const { frameWindow, renderer } = await mount(true);

    await act(async () => {
      (window as unknown as FakeWindow).sendMessage(
        readyEvent(renderer, frameWindow),
      );
    });
    await settle();
    expect(renderedText(renderer)).toContain(
      "Global Code settings need a decision",
    );

    const extensionsTab = renderer.root
      .findAllByType("button")
      .find(
        (button) =>
          button.props.role === "tab" && button.children.includes("Extensions"),
      );
    await act(async () => extensionsTab!.props.onClick());
    await settle();

    expect(
      desktopCode.openDirectCodeAttachmentExtensions,
    ).toHaveBeenCalledOnce();
    expect(renderedText(renderer)).not.toContain(
      "Global Code settings need a decision",
    );
    expect(renderer.root.findByType("iframe").props.tabIndex).toBe(0);

    await act(async () => renderer.unmount());
  });
});
