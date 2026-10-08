// @vitest-environment jsdom
import type {
  GitBranchList,
  GitHistory,
  GitStatus,
  ProjectSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { GitHistoryView, type GitHistoryHeaderState } from "./git-history";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getProjectWorktreeHistory: vi.fn(async () => history),
  getProjectWorktreeGitOperation: vi.fn(async () => ({ operation: null })),
  getProjectWorktreeBranches: vi.fn(async () => inventory),
  reconcileProjectWorktrees: vi.fn(async () => [primary]),
  pruneProjectWorktrees: vi.fn(async () => [primary]),
  createProjectWorktree: vi.fn(async () => ({
    ...primary,
    id: "secondary",
    isPrimary: false,
  })),
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));
vi.mock("@/lib/use-compact-layout", () => ({
  useCompactLayout: () => false,
  useNarrowViewport: () => false,
}));
const head = "a".repeat(40);
const date = "2026-10-08T12:00:00.000Z";
const primary: ProjectWorktreeSummary = {
  id: "primary",
  projectId: "project-one",
  projectSourceId: "source-one",
  workerId: "worker-one",
  rootKind: "git-worktree",
  name: "Primary",
  path: "/tmp/local",
  displayPath: "/tmp/local",
  isPrimary: true,
  isDefault: true,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: "main",
  head,
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: null,
  createdAt: date,
  updatedAt: date,
};
const status: GitStatus = {
  branch: "main",
  head,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
};
const history: GitHistory = {
  branch: "main",
  head,
  totalCount: 1,
  hasMore: false,
  nextCursor: null,
  commits: [
    {
      hash: head,
      shortHash: head.slice(0, 7),
      parents: [],
      subject: "Local history stays usable",
      authorName: "QA",
      authorEmail: "wqa@example.invalid",
      authoredAt: date,
      refs: [],
      isHead: true,
    },
  ],
};
const inventory: GitBranchList = {
  currentBranch: "main",
  head,
  detached: false,
  defaultRemote: null,
  remotes: [],
  pullStrategy: { mode: "unspecified", description: "No pull strategy" },
  truncated: false,
  generatedAt: date,
  branches: [
    {
      name: "main",
      fullRef: "refs/heads/main",
      kind: "local",
      current: true,
      hash: head,
      upstream: null,
      upstreamGone: false,
      ahead: 0,
      behind: 0,
      mergedIntoHead: true,
      remoteName: null,
      remoteAvailable: false,
      trackingLocalBranches: [],
      worktree: { label: "Primary", current: true },
      lastCommit: {
        hash: head,
        shortHash: head.slice(0, 7),
        subject: history.commits[0]!.subject,
        authorName: "QA",
        authoredAt: date,
      },
    },
  ],
};
function project(worktrees: boolean): ProjectSummary {
  return {
    id: "project-one",
    name: "Repository",
    position: 0,
    originKind: worktrees ? "github" : "managed-folder",
    capabilities: {
      git: true,
      github: worktrees,
      worktrees,
      replicas: worktrees,
      relocation: worktrees,
    },
    setupStatus: "ready",
    setupError: null,
    worktreePolicy: "agent-managed",
    source: null,
    replicas: [],
    github: worktrees
      ? {
          repositoryId: "repo-one",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        }
      : null,
    createdAt: date,
    updatedAt: date,
  };
}
const ignore = () => undefined;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let header: GitHistoryHeaderState | null;
const select = vi.fn();
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
  header = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function mount(worktrees: boolean, standalone = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <GitHistoryView
            chats={[]}
            navigationActive
            navigationRequest={null}
            onNavigationHandled={ignore}
            onCreateChat={ignore}
            onCreateAgentChat={async () => {
              throw Error("Unexpected chat");
            }}
            onCreateExplorer={ignore}
            onCreateHistory={ignore}
            onCreateTerminal={ignore}
            onHeaderChange={(value) => {
              header = value;
            }}
            onArchiveChat={async () => undefined}
            onOpenChat={ignore}
            onOpenGraphFile={ignore}
            onSelectWorktree={select}
            project={project(worktrees)}
            statuses={{ primary: status }}
            view="history"
            workers={[
              {
                workerId: "worker-one",
                online: true,
                name: "QA",
              } as WorkerSummary,
            ]}
            worktreeId="primary"
            worktrees={[primary]}
            standalone={standalone}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(name: string) {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (b) => b.textContent?.trim() === name || b.getAttribute("title") === name,
  );
  expect(result, `Missing button ${name}`).toBeDefined();
  return result!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function openBranches() {
  await click("Branches");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function branchMenu() {
  const trigger = button("Actions for main");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
function menuItem(name: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((i) => i.textContent?.trim() === name);
  expect(item, `Missing menu item ${name}`).toBeDefined();
  return item!;
}
function dialogs() {
  return document.querySelectorAll('[role="dialog"][data-state="open"]');
}
async function input(placeholder: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("History managed-worktree capabilities", () => {
  it("keeps local history readable while disabling create and prune with a reason", async () => {
    await mount(false);
    expect(container.textContent).toContain("Local history stays usable");
    for (const name of ["Create worktree", "Prune worktrees"]) {
      const control = button(name);
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-description")).toMatch(
        /does not support managed worktrees/i,
      );
      await click(name);
    }
    expect(dialogs()).toHaveLength(0);
    expect(api.createProjectWorktree).not.toHaveBeenCalled();
    expect(api.pruneProjectWorktrees).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "refreshes local history without managed reconciliation (standalone=%s)",
    async (standalone) => {
      await mount(false, standalone);
      vi.mocked(api.getProjectWorktreeHistory).mockClear();
      await act(async () => {
        if (standalone) button("Refresh Git history").click();
        else header!.refresh();
      });
      expect(api.getProjectWorktreeHistory).toHaveBeenCalled();
      expect(api.reconcileProjectWorktrees).not.toHaveBeenCalled();
    },
  );
  it("keeps local branch creation available while disabling managed checkout and cleanup", async () => {
    await mount(false);
    await openBranches();
    expect(button("New").disabled).toBe(false);
    expect(button("Clean up…").disabled).toBe(true);
    await branchMenu();
    expect(menuItem("Create worktree…").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () => menuItem("Create worktree…").click());
    expect(dialogs()).toHaveLength(0);
    expect(api.createProjectWorktree).not.toHaveBeenCalled();
  });
  it("still submits a managed creation and selects the returned lane", async () => {
    await mount(true);
    expect(button("Create worktree").disabled).toBe(false);
    await click("Create worktree");
    await input("Fix authentication", "Fix QA");
    await input("agent/manual/fix-auth", "codex/qa");
    await act(async () =>
      document
        .querySelector<HTMLFormElement>('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(api.createProjectWorktree).toHaveBeenCalledWith("project-one", {
      name: "Fix QA",
      sourceWorktreeId: "primary",
      mode: { type: "newBranch", branch: "codex/qa", startPoint: null },
    });
    expect(select).toHaveBeenCalledWith("secondary");
  });
  it("retains managed refresh and prune operations", async () => {
    await mount(true);
    await act(async () => header!.refresh());
    expect(api.reconcileProjectWorktrees).toHaveBeenCalledWith("project-one");
    await click("Prune worktrees");
    await click("Prune");
    expect(api.pruneProjectWorktrees).toHaveBeenCalledWith(
      "project-one",
      false,
    );
  });
  it("keeps branch-based managed creation enabled and prefills its revision", async () => {
    await mount(true);
    await openBranches();
    await branchMenu();
    expect(menuItem("Create worktree…").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    await act(async () => menuItem("Create worktree…").click());
    expect(dialogs()).toHaveLength(1);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="origin/main"]',
      )!.value,
    ).toBe("refs/heads/main");
  });
});
