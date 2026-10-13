import type { CodeTabSummary } from "@cantrip/protocol";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  CantripApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  createProtectedCodeAttachment: vi.fn(),
  getCodeRuntime: vi.fn(),
  releaseCodeAttachment: vi.fn(),
  saveAllCodeTab: vi.fn(),
  setCodeTabTheme: vi.fn(),
  stopCodeTab: vi.fn(),
}));
const desktop = vi.hoisted(() => ({
  preferProtectedCodeAttachment: vi.fn(),
  stopDirectCodeAttachment: vi.fn(),
  subscribePreferredCodeAttachmentUnavailable: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/desktop-code", () => desktop);
vi.mock("@/lib/browser-code-tunnel", () => ({
  bindBrowserCodeAttachmentFrame: vi.fn(() => () => undefined),
}));
vi.mock("@/lib/desktop-popout", () => ({ isMacosDesktopRuntime: () => false }));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { event: vi.fn() },
  operationalErrorMetadata: () => ({}),
}));

import { CodeView } from "./code-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Set<(event: MessageEvent) => void>();
const frameWindow = { postMessage: vi.fn() } as unknown as Window;
const tab = {
  id: "code-1",
  title: "Code",
  activeWorkerId: "worker-1",
  worktreeId: "worktree-1",
  status: "running",
} as CodeTabSummary;
const attachment = {
  attachmentId: "attachment-1",
  sessionId: "session-1",
  url: "http://localhost:43123/code/attachment-1/",
  runtime: { bridgeConnected: true, sessionId: "session-1", status: "running" },
};
let renderer: TestRenderer.ReactTestRenderer | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  listeners.clear();
  renderer = null;
  vi.stubGlobal("window", {
    addEventListener: (
      type: string,
      listener: (event: MessageEvent) => void,
    ) => {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => listeners.delete(listener),
  });
  api.createProtectedCodeAttachment.mockResolvedValue({
    attachmentId: "attachment-1",
    sessionId: "session-1",
    tunnelId: "tunnel-1",
  });
  api.setCodeTabTheme.mockResolvedValue(undefined);
  api.releaseCodeAttachment.mockResolvedValue(undefined);
  api.getCodeRuntime.mockResolvedValue(attachment.runtime);
  desktop.preferProtectedCodeAttachment.mockResolvedValue({
    attachment,
    transportKind: "relay",
  });
  desktop.stopDirectCodeAttachment.mockResolvedValue(undefined);
  desktop.subscribePreferredCodeAttachmentUnavailable.mockReturnValue(
    () => undefined,
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(active = true) {
  await act(async () => {
    renderer = TestRenderer.create(
      <CodeView active={active} appearance="dark" codeTab={tab} />,
      {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      },
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return new URL(renderer!.root.findByType("iframe").props.src as string);
}
async function ready(url: URL, overrides: Record<string, unknown> = {}) {
  await act(async () => {
    const event = {
      source: frameWindow,
      origin: url.origin,
      data: {
        type: "cantrip-code.workbench-ready",
        version: 1,
        nonce: url.searchParams.get("cantripFrameNonce"),
      },
      ...overrides,
    } as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  });
}
function coverCount() {
  return renderer!.root.findAll(
    (node) => node.props["data-slot"] === "code-workbench-startup-cover",
  ).length;
}

describe("Code view frame lifetime", () => {
  it("accepts late verified readiness without replacing its attachment or iframe", async () => {
    const url = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(coverCount()).toBe(1);
    await ready(url);
    expect(coverCount()).toBe(0);
    expect(renderer!.root.findByType("iframe").props.src).toBe(url.toString());
    expect(api.createProtectedCodeAttachment).toHaveBeenCalledOnce();
    expect(api.releaseCodeAttachment).not.toHaveBeenCalled();
  });

  it("does not spend a readiness deadline while its retained frame is hidden", async () => {
    const url = await mount(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    await ready(url);
    expect(coverCount()).toBe(0);
  });

  it("rejects foreign readiness and keeps real document failures terminal", async () => {
    const url = await mount();
    await ready(url, { origin: "https://foreign.example" });
    expect(coverCount()).toBe(1);
    await act(async () => {
      renderer!.root.findByType("iframe").props.onError();
    });
    await ready(url);
    expect(coverCount()).toBe(1);
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
  });
});
