import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useConversationPlacement } from "./use-conversation-placement";
const mocks = vi.hoisted(() => ({
  checkpoint: vi.fn(),
  matches: vi.fn(() => true),
  request: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@/components/chat/chat-transfer-lifecycle", () => ({
  checkpointChatView: mocks.checkpoint,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    serverId: "server",
    userId: "owner",
  }),
  clientSessionIdentityMatches: mocks.matches,
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("@/lib/workspace-conversation-handoff", () => ({
  createConversationHandoff: () => ({
    request: mocks.request,
    dispose: mocks.dispose,
  }),
}));
vi.mock("./detach-workspace-editors", () => ({
  detachWorkspaceEditors: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: TestRenderer.ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.clearAllMocks();
  mocks.matches.mockReturnValue(true);
});
it("releases the draft checkpoint and blocks placement when the account changes while saving", async () => {
  let finish!: (release: () => void) => void;
  mocks.checkpoint.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const moved = vi.fn();
  const onPlaced = vi.fn();
  const release = vi.fn();
  const controller = {
    getSnapshot: () => ({
      authoritative: { id: "workspace", projectId: "project" },
    }),
    placeConversation: async (
      _chat: string,
      _destination: unknown,
      options: { checkpoint(owner: unknown): Promise<() => void> },
    ) => {
      const done = await options.checkpoint({
        tabId: "view",
        chatId: "chat",
        projectId: "project",
      });
      moved();
      done();
    },
  };
  let place!: ReturnType<typeof useConversationPlacement>;
  function Harness() {
    place = useConversationPlacement(
      {
        controller,
        windowId: "main",
        surfaces: new Map(),
        explorers: new Map(),
      } as unknown as Parameters<typeof useConversationPlacement>[0],
      onPlaced,
    );
    return null;
  }
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  const action = place("project", "chat", { region: "bottom" });
  const rejected = expect(action).rejects.toThrow("context changed");
  mocks.matches.mockReturnValue(false);
  finish(release);
  await rejected;
  expect(release).toHaveBeenCalledOnce();
  expect(moved).not.toHaveBeenCalled();
  expect(onPlaced).not.toHaveBeenCalled();
});
it("rejects a stale drag session before opening or moving any view", async () => {
  const controller = {
    getSnapshot: () => ({
      authoritative: { id: "workspace", projectId: "project" },
    }),
    placeConversation: vi.fn(),
  };
  let place!: ReturnType<typeof useConversationPlacement>;
  function Harness() {
    place = useConversationPlacement(
      {
        controller,
        windowId: "main",
        surfaces: new Map(),
        explorers: new Map(),
      } as unknown as Parameters<typeof useConversationPlacement>[0],
      vi.fn(),
    );
    return null;
  }
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  mocks.matches.mockReturnValue(false);
  await expect(place("project", "chat", { region: "bottom" })).rejects.toThrow(
    "context changed",
  );
  expect(controller.placeConversation).not.toHaveBeenCalled();
});
it("finishes a sole-view return from durable ownership when the source closes before replying", async () => {
  const listeners = new Set<() => void>();
  const view = {
    id: "view",
    resource: {
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "chat",
    },
  };
  const layout = {
    id: "workspace",
    projectId: "project",
    windows: [
      { id: "popout", attachmentGeneration: 4, panes: [{ tabs: [view] }] },
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [] as { tabs: (typeof view)[] }[],
      },
    ],
  };
  let requestSignal: AbortSignal | undefined;
  mocks.request.mockImplementationOnce((_request, signal: AbortSignal) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("canceled"))),
    );
  });
  const moved = vi.fn();
  const controller = {
    getSnapshot: () => ({ authoritative: layout, projected: layout }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    placeConversation: async (
      _chat: string,
      _destination: unknown,
      options: { transfer(owner: unknown): Promise<void> },
    ) => {
      await options.transfer({
        windowId: "popout",
        paneId: "source",
        viewId: "view",
      });
      moved();
    },
  };
  let place!: ReturnType<typeof useConversationPlacement>;
  function Harness() {
    place = useConversationPlacement(
      {
        controller,
        windowId: "main",
        surfaces: new Map(),
        explorers: new Map(),
      } as unknown as Parameters<typeof useConversationPlacement>[0],
      vi.fn(),
    );
    return null;
  }
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  const result = place("project", "chat", { region: "right" });
  expect(moved).not.toHaveBeenCalled();
  // Preparing the transfer still leaves the source authoritative.
  for (const listener of listeners) listener();
  await Promise.resolve();
  expect(moved).not.toHaveBeenCalled();
  layout.windows[0]!.panes = [];
  layout.windows[1]!.panes = [{ tabs: [view] }];
  for (const listener of listeners) listener();
  await result;
  expect(moved).toHaveBeenCalledOnce();
  expect(requestSignal?.aborted).toBe(true);
  expect(listeners.size).toBe(0);
});
