// @vitest-environment jsdom
import type { RemoteDesktopSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRemoteSurfaceWorkerLinkOptions } from "@/lib/use-remote-surface-worker-link";

const transport = vi.hoisted(() => ({
  sendFrame: vi.fn((_channel: string, _payload: Uint8Array) => true),
  options: null as UseRemoteSurfaceWorkerLinkOptions | null,
}));
vi.mock("@/lib/use-remote-surface-worker-link", () => ({
  useRemoteSurfaceWorkerLink: (options: UseRemoteSurfaceWorkerLinkOptions) => {
    transport.options = options;
    return {
      connectionState: "ready",
      activeRoute: null,
      activeRoutes: null,
      error: null,
      retry: vi.fn(),
      sendFrame: transport.sendFrame,
      setError: vi.fn(),
    };
  },
}));
vi.mock("@/lib/api", () => ({
  getWorkers: vi.fn(async () => []),
  updateRemoteDesktopTarget: vi.fn(),
}));
vi.mock("@/lib/surface-private-state-worker-encryption", () => ({
  ensureSurfacePrivateStateWorkerEncryption: vi.fn(async () => {}),
}));

import { ManagedRemoteDesktopView } from "./managed-remote-desktop-view";

const desktop: RemoteDesktopSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workerId: "worker-1",
  title: "QA Desktop",
  position: 0,
  stateRevision: 1,
  status: "active",
  lastError: null,
  target: { kind: "monitor", id: null, name: null },
  createdAt: "2026-10-08T12:00:00Z",
  updatedAt: "2026-10-08T12:00:00Z",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn(async () => "WQA_DESKTOP_PASTE_42") },
  });
  transport.sendFrame.mockReset().mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ManagedRemoteDesktopView desktop={desktop} />
      </QueryClientProvider>,
    );
  });
  transport.sendFrame.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function paste() {
  const button = container.querySelector<HTMLButtonElement>(
    'button[title="Paste local clipboard"]',
  )!;
  expect(button).not.toBeNull();
  await act(async () => {
    button.click();
  });
}
async function grantEpoch() {
  await act(async () => {
    transport.options!.onFrame(
      {
        header: { channel: "control" } as never,
        payload: new TextEncoder().encode(
          JSON.stringify({
            type: "desktop-input",
            epoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            message: null,
          }),
        ),
      },
      { isCurrent: () => true, reportError: vi.fn() },
    );
  });
  transport.sendFrame.mockClear();
}
function outboundClipboard() {
  return transport.sendFrame.mock.calls.filter(
    (call) =>
      JSON.parse(new TextDecoder().decode(call[1] as Uint8Array)).type ===
      "clipboard",
  );
}

describe("Managed Remote Desktop clipboard toolbar", () => {
  it("reports not sent with no input epoch and emits no clipboard frame", async () => {
    await paste();
    expect(container.textContent).toContain(
      "Clipboard was not sent. Remote input is unavailable.",
    );
    expect(container.textContent).not.toContain("Clipboard pasted");
    expect(outboundClipboard()).toHaveLength(0);
  });
  it("reports a rejected transport rather than a successful paste", async () => {
    await grantEpoch();
    transport.sendFrame.mockReturnValue(false);
    await paste();
    expect(container.textContent).toContain(
      "Clipboard was not sent. Remote input is unavailable.",
    );
    expect(outboundClipboard()).toHaveLength(1);
  });
  it("reports sent for accepted dispatch and includes the epoch and canary", async () => {
    await grantEpoch();
    await paste();
    expect(container.textContent).toContain("Clipboard sent");
    const frames = outboundClipboard();
    expect(frames).toHaveLength(1);
    expect(
      JSON.parse(new TextDecoder().decode(frames[0]![1] as Uint8Array)),
    ).toMatchObject({
      type: "clipboard",
      operation: "paste-text",
      text: "WQA_DESKTOP_PASTE_42",
      inputEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      inputSequence: 1,
    });
  });
});
