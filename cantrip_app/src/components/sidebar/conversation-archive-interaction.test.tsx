// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { chatSummarySchema } from "@cantrip/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  fork: vi.fn(),
}));
vi.mock("@/lib/api/conversations", () => ({
  getConversationCatalog: api.catalog,
  archiveAgentConversation: api.archive,
  restoreAgentConversation: api.restore,
  permanentlyDeleteAgentConversation: api.remove,
  prepareConversationCreation: vi.fn(),
  prepareConversationFork:
    async (...args: unknown[]) =>
    () =>
      api.fork(...args),
}));
vi.mock("@/lib/api/chats", () => ({
  renameChat: api.rename,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ userId: "owner" }),
  clientSessionIdentityMatches: () => true,
}));
vi.mock("@/components/chat/chat-transfer-lifecycle", () => ({
  checkpointChatView: async () => () => {},
}));
import { ProjectConversationList } from "./project-conversation-list";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const chat = chatSummarySchema.parse({
  id: "one",
  projectId: "project",
  experience: "agent",
  title: "Agent one",
  position: 0,
  status: "idle",
  activeWorkerId: null,
  activeWorktreeId: "tree",
  placementRevision: 1,
  worktreeMode: "agent-managed",
  modelId: null,
  reasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: false,
  automationPaused: false,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
});
let active: Array<typeof chat>;
let archived: Array<Record<string, unknown>>;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const openConversation = vi.fn();
const controller = {
  openConversation,
  getSnapshot: () => ({ projected: { windows: [] } }),
  refresh: async () => {},
} as unknown as WorkspaceCommandClient;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function mount(
  archiveFocusRequest?: string,
  onArchiveFocusHandled?: () => void,
  onPlace?: (
    chatId: string,
    region: "center" | "right" | "bottom",
  ) => Promise<unknown>,
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ProjectConversationList
          onPlace={onPlace}
          archiveFocusRequest={archiveFocusRequest}
          onArchiveFocusHandled={onArchiveFocusHandled}
          projectId="project"
          visible
          controller={controller}
          selectedChatId={null}
          workers={[]}
          onOpened={() => {}}
          focusWindow={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  await flush();
}
function item(label: string) {
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent === label);
  expect(element).toBeDefined();
  return element!;
}
function button(label: string) {
  const element = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((el) => el.textContent === label);
  expect(element).toBeDefined();
  return element!;
}
beforeEach(() => {
  vi.clearAllMocks();
  active = [chat, { ...chat, id: "two", title: "Agent two" }];
  archived = [];
  api.catalog.mockImplementation(
    async (_: string, { state }: { state: string }) => ({
      state,
      items: state === "active" ? [...active] : [...archived],
      total: state === "active" ? active.length : archived.length,
      nextCursor: null,
    }),
  );
  api.archive.mockImplementation(async (id: string) => {
    const target = active.find((c) => c.id === id)!;
    active = active.filter((c) => c.id !== id);
    archived = [
      ...archived,
      {
        ...target,
        archivedAt: chat.createdAt,
        expiresAt: "2027-01-28T00:00:00.000Z",
        lastUsedAt: chat.createdAt,
      },
    ];
  });
  api.restore.mockImplementation(async (_: string, id: string) => {
    archived = archived.filter((c) => c.id !== id);
    active = [chat, ...active];
    return chat;
  });
  api.remove.mockImplementation(async (id: string) => {
    archived = archived.filter((c) => c.id !== id);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
it("archives by middle-click, restores from the keyboard menu, and never opens a rail view", async () => {
  await mount();
  const row = host.querySelector<HTMLButtonElement>(
    '[data-conversation-id="one"]',
  )!;
  row.focus();
  await act(async () =>
    row.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })),
  );
  await flush();
  expect(api.archive).toHaveBeenCalledWith("one", false, { userId: "owner" });
  expect(host.querySelector('[data-conversation-id="one"]')).toBeNull();
  expect(document.activeElement?.getAttribute("data-conversation-id")).toBe(
    "two",
  );
  const archivedRow = host.querySelector<HTMLButtonElement>(
    '[data-archived-conversation-id="one"]',
  )!;
  archivedRow.focus();
  await act(async () =>
    archivedRow.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(item("Permanently Delete")).toBeDefined();
  await act(async () => item("Restore").click());
  await flush();
  expect(api.restore).toHaveBeenCalledWith("project", "one", {
    userId: "owner",
  });
  expect(openConversation).not.toHaveBeenCalled();
  expect(
    host.querySelector('[data-archived-conversation-id="one"]'),
  ).toBeNull();
  expect(document.activeElement?.getAttribute("data-conversation-id")).toBe(
    "one",
  );
});
it("requires explicit Stop and Archive for a running Agent", async () => {
  active = [{ ...chat, status: "running" }];
  await mount();
  const row = host.querySelector<HTMLButtonElement>(
    '[data-conversation-id="one"]',
  )!;
  await act(async () =>
    row.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })),
  );
  expect(api.archive).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => button("Stop and Archive").click());
  await flush();
  expect(api.archive).toHaveBeenCalledWith("one", true, { userId: "owner" });
});
it("permanent deletion is confirmed and returns focus to the archive heading", async () => {
  active = [];
  archived = [
    {
      ...chat,
      archivedAt: chat.createdAt,
      expiresAt: "2027-01-28T00:00:00.000Z",
    },
  ];
  await mount();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[data-archived-conversation-id="one"]',
      )!
      .click(),
  );
  await act(async () => item("Permanently Delete").click());
  expect(api.remove).not.toHaveBeenCalled();
  await act(async () => button("Permanently Delete").click());
  await flush();
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(document.activeElement?.hasAttribute("data-archive-heading")).toBe(
    true,
  );
});

it("focuses the inline archive heading for Settings navigation without opening a chat", async () => {
  const handled = vi.fn();
  await mount("settings-navigation", handled);
  expect(document.activeElement).toBe(
    host.querySelector("[data-archive-heading]"),
  );
  expect(handled).toHaveBeenCalledOnce();
  expect(openConversation).not.toHaveBeenCalled();
});
it("does not restore or delete an archived row on middle click", async () => {
  archived = [
    {
      ...chat,
      archivedAt: "2026-10-30T00:00:00Z",
      expiresAt: "2027-01-28T00:00:00Z",
      messageCount: 0,
    },
  ];
  active = [];
  await mount();
  const row = host.querySelector<HTMLButtonElement>(
    "[data-archived-conversation-id]",
  )!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  });
  expect(api.restore).not.toHaveBeenCalled();
  expect(api.remove).not.toHaveBeenCalled();
  expect(api.archive).not.toHaveBeenCalled();
});

it.each([
  ["Place in top rail", "center"],
  ["Place in right rail", "right"],
  ["Place in bottom rail", "bottom"],
] as const)("offers keyboard placement: %s", async (label, region) => {
  const place = vi.fn(async () => {});
  await mount(undefined, undefined, place);
  const row = host.querySelector<HTMLButtonElement>("[data-conversation-id]")!;
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "F10",
        shiftKey: true,
      }),
    ),
  );
  await act(async () => item(label).click());
  expect(place).toHaveBeenCalledWith("one", region);
  expect(openConversation).not.toHaveBeenCalled();
  expect(api.archive).not.toHaveBeenCalled();
});

it("forks from the sidebar without creating or opening a rail tab", async () => {
  api.fork.mockImplementation(async () => {
    const fork = { ...chat, id: "fork", title: "Agent one (fork)" };
    active.push(fork);
    return fork;
  });
  await mount();
  const row = host.querySelector<HTMLElement>('[data-conversation-id="one"]')!;
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  await act(async () => item("Fork").click());
  await flush();
  expect(api.fork).toHaveBeenCalledWith("project", "one", "Agent one");
  expect(host.querySelector('[data-conversation-id="fork"]')).not.toBeNull();
  expect(openConversation).not.toHaveBeenCalled();
});
it("renames through the shared encrypted chat action and refreshes the catalog", async () => {
  api.rename.mockImplementation(async (id: string, title: string) => {
    active = active.map((chat) => (chat.id === id ? { ...chat, title } : chat));
    return active.find((chat) => chat.id === id);
  });
  await mount();
  const row = host.querySelector<HTMLElement>('[data-conversation-id="one"]')!;
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  await act(async () => item("Rename").click());
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Chat name"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Renamed agent");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Rename").click());
  await flush();
  expect(api.rename).toHaveBeenCalledWith("one", "Renamed agent");
  expect(host.textContent).toContain("Renamed agent");
});

it.each(["active", "archived"])(
  "does not cancel the %s Live refresh by requesting an obsolete next cursor",
  async (state) => {
    const summary =
      state === "active"
        ? chat
        : {
            ...chat,
            archivedAt: chat.createdAt,
            expiresAt: "2027-01-28T00:00:00.000Z",
            lastUsedAt: chat.createdAt,
          };
    let refreshing = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cursors: string[] = [];
    api.catalog.mockImplementation(
      async (_: string, query: { state: string; cursor?: string }) => {
        if (query.state !== state)
          return { state: query.state, items: [], total: 0, nextCursor: null };
        if (query.cursor) cursors.push(query.cursor);
        else if (refreshing) await held;
        return {
          state,
          items: [summary],
          total: 2,
          nextCursor: refreshing ? "fresh-cursor" : "old-cursor",
        };
      },
    );
    await mount();
    refreshing = true;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.invalidateQueries({
        queryKey: ["chats", "project", "conversations", state],
      });
    });
    await flush();
    await act(async () =>
      button(
        state === "active" ? "Load more chats" : "Load more archived chats",
      ).click(),
    );
    try {
      expect(cursors).toEqual([]);
    } finally {
      await act(async () => {
        release();
        await refresh;
      });
    }
    await flush();
    await act(async () =>
      button(
        state === "active" ? "Load more chats" : "Load more archived chats",
      ).click(),
    );
    await flush();
    expect(cursors).toEqual(["fresh-cursor"]);
  },
);
