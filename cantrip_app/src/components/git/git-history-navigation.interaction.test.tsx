// @vitest-environment jsdom
import type { ProjectSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getProjectWorktreeFileHistory } from "@/lib/api";
import {
  defaultGitHistoryOptions,
  openGitFileHistoryEvent,
  parseGitHistoryRoute,
  pushGitHistoryRoute,
  requestGitFileHistory,
} from "@/lib/git-history-navigation";
import { useGitHistoryNavigation } from "@/lib/use-git-history-navigation";
import { GitHistoryView } from "./git-history";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getProjectWorktreeFileHistory: vi.fn(async (_project, _worktree, path) => ({
    path,
    revision: "1".repeat(40),
    commits: [],
    hasMore: false,
    nextCursor: null,
  })),
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));
vi.mock("@/lib/use-compact-layout", () => ({
  useCompactLayout: () => false,
  useNarrowViewport: () => false,
}));

const project = {
  id: "project-one",
  name: "Repository",
  position: 0,
  originKind: "github",
  capabilities: {
    git: true,
    github: true,
    worktrees: true,
    replicas: true,
    relocation: true,
  },
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  source: null,
  replicas: [],
  github: {
    repositoryId: "repo-one",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  },
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
} satisfies ProjectSummary;
const ignore = () => undefined;
const openFile = vi.fn();
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

function route(path: string, projectId = project.id) {
  pushGitHistoryRoute({
    projectId,
    worktreeId: "primary",
    filePath: path,
    commit: null,
    selectedCommits: [],
    comparison: null,
    options: defaultGitHistoryOptions,
  });
}

async function mount({
  focus = "main",
  dock = true,
  dockProject = project,
}: { focus?: string; dock?: boolean; dockProject?: ProjectSummary } = {}) {
  function Workspace() {
    const [focused, setFocused] = useState(focus);
    const navigation = useGitHistoryNavigation();
    // Match the shell's request: select the requested History, then dispatch
    // popstate in the same event, before the new pane props have committed.
    useEffect(() => {
      const handler = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        route(detail.path, detail.projectId);
        setFocused("main");
        window.dispatchEvent(new PopStateEvent("popstate"));
      };
      window.addEventListener(openGitFileHistoryEvent, handler);
      return () => window.removeEventListener(openGitFileHistoryEvent, handler);
    }, []);
    return (
      <>
        <button data-focus="main" onClick={() => setFocused("main")}>
          Focus main
        </button>
        <button data-focus="dock" onClick={() => setFocused("dock")}>
          Focus dock
        </button>
        {[
          { id: "main", project },
          ...(dock ? [{ id: "dock", project: dockProject }] : []),
        ].map((pane) => (
          <section data-pane={pane.id} key={pane.id}>
            <GitHistoryView
              navigationActive={pane.id === focused}
              navigationRequest={navigation.request}
              onNavigationHandled={navigation.complete}
              chats={[]}
              onCreateChat={ignore}
              onCreateAgentChat={async () => {
                throw new Error("Unexpected chat creation");
              }}
              onCreateExplorer={ignore}
              onCreateHistory={ignore}
              onCreateTerminal={ignore}
              onHeaderChange={ignore}
              onArchiveChat={async () => undefined}
              onOpenChat={ignore}
              onOpenGraphFile={(worktreeId, path) =>
                openFile(pane.id, worktreeId, path)
              }
              onSelectWorktree={ignore}
              project={pane.project}
              statuses={{}}
              view="history"
              workers={[]}
              worktreeId="primary"
              worktrees={[]}
            />
          </section>
        ))}
      </>
    );
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <Workspace />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

function dialogs() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"][data-state="open"]',
    ),
  ];
}
async function request(path = "src/example.ts") {
  await act(async () =>
    requestGitFileHistory({
      projectId: project.id,
      worktreeId: "primary",
      path,
    }),
  );
}
async function closeOnce() {
  const close = [
    ...dialogs().at(-1)!.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Close");
  expect(close).toBeDefined();
  await act(async () => close!.click());
}

describe("History pane navigation ownership", () => {
  it("keeps a deep link pending while workspace reconciliation has no focused pane", async () => {
    route("pending.txt");
    await mount({ focus: "" });
    expect(dialogs()).toHaveLength(0);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-focus="main"]')!
        .click(),
    );
    expect(dialogs()).toHaveLength(1);
    expect(
      dialogs()[0]!.querySelector<HTMLInputElement>(
        '[aria-label="Repository-relative path"]',
      )!.value,
    ).toBe("pending.txt");
  });

  it("keeps local History filters when focus changes without navigation", async () => {
    pushGitHistoryRoute({
      projectId: project.id,
      worktreeId: "primary",
      filePath: null,
      commit: null,
      comparison: null,
      selectedCommits: [],
      options: {
        ...defaultGitHistoryOptions,
        filters: { ...defaultGitHistoryOptions.filters, message: "Main only" },
      },
    });
    await mount();
    expect(
      container.querySelector(
        '[data-pane="main"] [title="Remove Message filter"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-pane="dock"] [title="Remove Message filter"]',
      ),
    ).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-focus="dock"]')!
        .click(),
    );
    expect(
      container.querySelector(
        '[data-pane="main"] [title="Remove Message filter"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-pane="dock"] [title="Remove Message filter"]',
      ),
    ).toBeNull();
    expect(
      parseGitHistoryRoute(window.location.search).options.filters.message,
    ).toBeNull();
  });

  it("restores subsequent popstate navigations in the active pane", async () => {
    await mount();
    await request("first.txt");
    await act(async () => {
      route("second.txt");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(dialogs()).toHaveLength(1);
    expect(
      dialogs()[0]!.querySelector<HTMLInputElement>(
        '[aria-label="Repository-relative path"]',
      )!.value,
    ).toBe("second.txt");
    await closeOnce();
    expect(dialogs()).toHaveLength(0);
  });

  it("opens one real file-history portal for one request with main and dock mounted", async () => {
    await mount();
    await request();
    expect(dialogs()).toHaveLength(1);
    expect(
      dialogs()[0]!.querySelector<HTMLInputElement>(
        '[aria-label="Repository-relative path"]',
      )!.value,
    ).toBe("src/example.ts");
    expect(getProjectWorktreeFileHistory).toHaveBeenCalledWith(
      project.id,
      "primary",
      "src/example.ts",
      "HEAD",
      0,
    );
  });

  it("one Close removes every dialog and releases background focus; focusing the dock does not resurrect it", async () => {
    await mount();
    await request();
    await closeOnce();
    expect(dialogs()).toHaveLength(0);
    expect(container.closest('[aria-hidden="true"]')).toBeNull();
    expect(parseGitHistoryRoute(window.location.search).filePath).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-focus="dock"]',
    )!;
    await act(async () => {
      button.focus();
      button.click();
    });
    expect(document.activeElement).toBe(button);
    expect(dialogs()).toHaveLength(0);
  });

  it("hands a same-event request from the previously focused dock to the requested main pane", async () => {
    await mount({ focus: "dock" });
    await request("README.md");
    expect(dialogs()).toHaveLength(1);
    const compare = [
      ...dialogs()[0]!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "compare")!;
    await act(async () => compare.click());
    const open = dialogs()[0]!.querySelector<HTMLButtonElement>(
      'button[title="Open file"]',
    )!;
    expect(open).not.toBeNull();
    await act(async () => open.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(
      "main",
      "primary",
      "README.md",
    );
    await closeOnce();
    expect(dialogs()).toHaveLength(0);
  });

  it.each(["main", "dock"])(
    "restores a deep link once with %s focused and another matching pane mounted",
    async (focus) => {
      route("docs/readme.md");
      await mount({ focus });
      expect(dialogs()).toHaveLength(1);
      expect(
        dialogs()[0]!.querySelector<HTMLInputElement>(
          '[aria-label="Repository-relative path"]',
        )!.value,
      ).toBe("docs/readme.md");
      await closeOnce();
      expect(dialogs()).toHaveLength(0);
    },
  );

  it("keeps single-History deep links working", async () => {
    route("single.txt");
    await mount({ dock: false });
    expect(dialogs()).toHaveLength(1);
    await closeOnce();
    expect(dialogs()).toHaveLength(0);
  });

  it("does not let a distinct background project open or overwrite the foreground route", async () => {
    await mount({ dockProject: { ...project, id: "project-other" } });
    await request("foreground.txt");
    expect(dialogs()).toHaveLength(1);
    expect(parseGitHistoryRoute(window.location.search).projectId).toBe(
      project.id,
    );
    expect(getProjectWorktreeFileHistory).not.toHaveBeenCalledWith(
      "project-other",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
