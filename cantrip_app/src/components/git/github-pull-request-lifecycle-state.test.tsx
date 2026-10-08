// @vitest-environment jsdom
import { githubPullRequestOverviewSchema } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GithubPullRequestDialog } from "./github-pull-request-dialog";

vi.mock("@/lib/use-compact-layout", () => ({
  useCompactLayout: () => false,
  useNarrowViewport: () => false,
}));

const key = ["github-pull-request", "project", "worktree", 3, "overview"];
const base = githubPullRequestOverviewSchema.parse({
  number: 3,
  title: "Lifecycle regression",
  state: "open",
  url: "https://github.com/example/repo/pull/3",
  author: "qa",
  commentCount: 0,
  labels: [],
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  closedAt: null,
  body: null,
  draft: true,
  merged: false,
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  comments: [],
  commentsTruncated: false,
  requestedReviewers: [],
  mergeable: null,
  mergeableState: "unknown",
  reviewDecision: "none",
  checksState: "unknown",
  additions: 0,
  deletions: 0,
  changedFileCount: 0,
  commitCount: 1,
  reviews: [],
  reviewsTruncated: false,
  reviewThreads: [],
  reviewThreadsTruncated: false,
});
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function show(open = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <GithubPullRequestDialog
            chats={[]}
            worktrees={[]}
            projectId="project"
            worktreeId="worktree"
            pullRequestNumber={open ? 3 : null}
            onOpenChange={() => {}}
            onCheckedOut={() => {}}
            onCleanupAgentWorkflow={async () => {}}
            onOpenActionsRun={() => {}}
            onStartAgent={async () => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}
function label() {
  return document.querySelector('[role="dialog"] [data-slot="badge"]')
    ?.textContent;
}
describe("PR detail lifecycle state", () => {
  it.each([
    ["open", true, false, "draft"],
    ["open", false, false, "open"],
    ["closed", true, false, "closed"],
    ["closed", false, false, "closed"],
    ["closed", true, true, "merged"],
  ] as const)(
    "renders state=%s draft=%s merged=%s as %s",
    async (state, draft, merged, expected) => {
      client.setQueryData(key, { ...base, state, draft, merged });
      await show();
      expect(label()).toBe(expected);
    },
  );
  it("updates an open draft after close and retains closed after detail reopening", async () => {
    client.setQueryData(key, base);
    await show();
    expect(label()).toBe("draft");
    await act(async () =>
      client.setQueryData(key, {
        ...base,
        state: "closed",
        closedAt: "2026-10-08T01:00:00Z",
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(label()).toBe("closed");
    await show(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await show();
    expect(label()).toBe("closed");
  });
});
