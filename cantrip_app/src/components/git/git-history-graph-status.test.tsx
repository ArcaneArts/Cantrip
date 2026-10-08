// @vitest-environment jsdom
import {
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
  type ProjectSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryGraphSurface } from "@/components/repository-graph";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { GitHistoryView, type GitHistoryHeaderState } from "./git-history";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getProjectWorktreeGraphSnapshot: vi.fn(),
  getProjectWorktreeGraphMetrics: vi.fn(),
  getProjectWorktreeGraphCommitOverlay: vi.fn(async () => {
    throw new Error("No commit overlay in fixture");
  }),
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));
vi.mock("@/lib/use-compact-layout", () => ({
  useCompactLayout: () => false,
  useNarrowViewport: () => false,
}));
vi.mock("@/components/repository-graph", async (original) => ({
  ...(await original<typeof import("@/components/repository-graph")>()),
  RepositoryGraphSurface: ({
    nodes,
    onActivateNode,
    ariaLabel,
  }: ComponentProps<typeof RepositoryGraphSurface>) => (
    <section aria-label={ariaLabel} data-scene-count={nodes.length}>
      {nodes
        .filter((node) => node.kind === "file")
        .slice(0, 2)
        .map((node) => (
          <button
            key={node.id}
            onClick={() =>
              onActivateNode?.({
                ...node,
                aggregated: false,
                depth: 1,
                hiddenDescendantCount: 0,
                x: 0,
                y: 0,
              })
            }
          >
            Open {node.path}
          </button>
        ))}
    </section>
  ),
}));

const date = "2026-10-08T12:00:00.000Z",
  head = "a".repeat(40);
const project: ProjectSummary = {
  id: "project-one",
  name: "Repository",
  position: 0,
  originKind: "managed-folder",
  capabilities: {
    git: true,
    github: false,
    worktrees: false,
    replicas: false,
    relocation: false,
  },
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  source: null,
  replicas: [],
  github: null,
  createdAt: date,
  updatedAt: date,
};
function snapshot(count: number, revision = head) {
  return gitGraphSnapshotSchema.parse({
    analyzerVersion: 1,
    revision,
    branch: "main",
    rootPath: null,
    rootId: "directory:.",
    totalNodes: count,
    truncated: false,
    analyzedAt: date,
    analysis: {
      structure: "ready",
      lines: "ready",
      history: "ready",
      blame: "deferred",
    },
    nodes: [
      {
        id: "directory:.",
        path: null,
        parentId: null,
        name: "Repository",
        kind: "directory",
        objectId: head,
        byteSize: count * 10,
        extension: null,
        language: null,
      },
      ...Array.from({ length: count - 1 }, (_, i) => ({
        id: "file:note" + i + ".txt",
        path: "note" + i + ".txt",
        parentId: "directory:.",
        name: "note" + i + ".txt",
        kind: "file",
        objectId: head,
        byteSize: 10,
        extension: "txt",
        language: null,
      })),
    ],
  });
}
function metrics(revision = head) {
  return gitGraphMetricsSchema.parse({
    analyzerVersion: 1,
    revision,
    rootPath: null,
    historyScope: "current-branch",
    renameAware: false,
    analyzedAt: date,
    analysis: {
      structure: "ready",
      lines: "ready",
      history: "ready",
      blame: "deferred",
    },
    nodes: [
      {
        nodeId: "directory:.",
        path: null,
        lineCount: 24,
        binary: false,
        commitTouches: 1,
        additions: 24,
        deletions: 0,
        churn: 24,
        binaryCommitTouches: 0,
        firstChangedAt: date,
        lastChangedAt: date,
        dominantAuthorName: null,
        dominantAuthorEmail: null,
        dominantAuthorShare: null,
        averageBlameAgeDays: null,
      },
    ],
  });
}
const ignore = () => {};
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
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
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.getProjectWorktreeGraphSnapshot).mockResolvedValue(
    snapshot(25),
  );
  vi.mocked(api.getProjectWorktreeGraphMetrics).mockImplementation(
    async (_project, _worktree, options) => metrics(options?.revision),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const common = {
  chats: [],
  navigationRequest: null,
  onNavigationHandled: ignore,
  onCreateChat: ignore,
  onCreateAgentChat: async () => {
    throw new Error("Unexpected agent");
  },
  onCreateExplorer: ignore,
  onCreateHistory: ignore,
  onCreateTerminal: ignore,
  onArchiveChat: async () => {},
  onOpenChat: ignore,
  onSelectWorktree: ignore,
  project,
  statuses: {},
  view: "history" as const,
  workers: [],
  worktrees: [],
};
function Workspace() {
  const [graph, setGraph] = useState(true),
    [worktreeId, setWorktreeId] = useState("primary"),
    [header, setHeader] = useState<GitHistoryHeaderState | null>(null),
    [dockHeader, setDockHeader] = useState<GitHistoryHeaderState | null>(null);
  return (
    <>
      <output aria-label="Graph header">
        {header?.graphNodes ?? 0} repository nodes · {header?.head}
      </output>
      <output aria-label="Dock header">
        {dockHeader?.graphNodes ?? 0} repository nodes
      </output>
      <button onClick={() => setGraph(true)}>Return to Graph</button>
      <button onClick={() => setWorktreeId("secondary")}>Other worktree</button>
      <section data-main>
        {graph ? (
          <GitHistoryView
            {...common}
            activeSection="graph"
            navigationActive
            onHeaderChange={setHeader}
            onOpenGraphFile={() => setGraph(false)}
            worktreeId={worktreeId}
          />
        ) : (
          <div>File preview</div>
        )}
      </section>
      <section data-dock>
        <GitHistoryView
          {...common}
          activeSection="history"
          navigationActive={false}
          onHeaderChange={setDockHeader}
          onOpenGraphFile={ignore}
          worktreeId="primary"
        />
      </section>
    </>
  );
}
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <Workspace />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
}
async function click(name: string) {
  const b = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  );
  expect(b).toBeDefined();
  await act(async () => b!.click());
  await settle();
}
function expectCount(count: number) {
  expect(
    container.querySelector('[aria-label="Graph header"]')!.textContent,
  ).toContain(`${count} repository nodes`);
  expect(
    container
      .querySelector("[data-main] [data-scene-count]")!
      .getAttribute("data-scene-count"),
  ).toBe(String(count));
  expect(container.querySelector("[data-main]")!.textContent).toContain(
    `${count} nodes · lines ready · history ready`,
  );
  expect(
    container.querySelector('[aria-label="Dock header"]')!.textContent,
  ).toBe("0 repository nodes");
}
function seed(worktree: string, count: number, revision = head) {
  client.setQueryData(
    ["git-graph-snapshot", project.id, worktree, undefined, "HEAD", 0],
    snapshot(count, revision),
  );
  client.setQueryData(
    ["git-graph-metrics", project.id, worktree, revision, false, undefined, 0],
    metrics(revision),
  );
}

describe("cached Graph status publication", () => {
  it("retains the actual snapshot count through repeated file round trips and a changed revision with docked History", async () => {
    await mount();
    expectCount(25);
    for (let i = 0; i < 2; i++) {
      await click("Open note0.txt");
      expect(container.querySelector("[data-main]")!.textContent).toBe(
        "File preview",
      );
      await click("Return to Graph");
      expectCount(25);
    }
    expect(api.getProjectWorktreeGraphSnapshot).toHaveBeenCalledTimes(1);
    const next = "b".repeat(40);
    await act(async () => {
      client.setQueryData(
        ["git-graph-snapshot", project.id, "primary", undefined, "HEAD", 0],
        snapshot(31, next),
      );
    });
    await settle();
    expectCount(31);
    expect(
      container.querySelector('[aria-label="Graph header"]')!.textContent,
    ).toContain(next);
    await click("Open note1.txt");
    await click("Return to Graph");
    expectCount(31);
    expect(api.getProjectWorktreeGraphSnapshot).toHaveBeenCalledTimes(1);
  });
  it("publishes a fresh cached snapshot on mount and when the same surface retargets to another worktree", async () => {
    seed("primary", 25);
    seed("secondary", 9, "c".repeat(40));
    await mount();
    expectCount(25);
    await click("Other worktree");
    expectCount(9);
    expect(
      container.querySelector('[aria-label="Graph header"]')!.textContent,
    ).toContain("c".repeat(40));
    expect(api.getProjectWorktreeGraphSnapshot).not.toHaveBeenCalled();
  });
  it("clears a previous worktree count while the new snapshot is loading", async () => {
    let resolveSnapshot!: (value: ReturnType<typeof snapshot>) => void;
    const pending = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.mocked(api.getProjectWorktreeGraphSnapshot).mockImplementation(
      async (_project, worktree) =>
        worktree === "primary" ? snapshot(25) : pending,
    );
    await mount();
    expectCount(25);
    await click("Other worktree");
    expect(
      container.querySelector('[aria-label="Graph header"]')!.textContent,
    ).toContain("0 repository nodes");
    expect(
      container.querySelector("[data-main] [data-scene-count]"),
    ).toBeNull();
    await act(async () => {
      resolveSnapshot(snapshot(9, "c".repeat(40)));
    });
    await settle();
    await settle();
    expectCount(9);
    expect(api.getProjectWorktreeGraphSnapshot).toHaveBeenCalledTimes(2);
  });
});
