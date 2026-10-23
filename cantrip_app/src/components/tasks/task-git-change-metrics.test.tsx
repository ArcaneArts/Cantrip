// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChatSummary,
  TaskDetail,
  GitChangeSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProtectedRepositoryOperation } from "@/lib/api/repository-operations";
import {
  TaskGitChangeMetrics,
  taskGitChangesQueryKey,
} from "./task-git-change-metrics";
vi.mock("@/lib/api/repository-operations", () => ({
  runProtectedRepositoryOperation: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const chat = {
  id: "task-chat",
  projectId: "project",
  activeWorktreeId: "chat-worktree",
} as ChatSummary;
const task = {
  createdAt: "2026-10-22T10:00:00Z",
  implementationStartedAt: "2026-10-22T10:01:00Z",
  completedAt: null,
} as TaskDetail;
const data: GitChangeSummary = {
  filesChanged: 12,
  additions: 234,
  deletions: 56,
  commits: 3,
  uncommittedFiles: 2,
  binaryFiles: 1,
  partial: false,
  observedAt: "2026-10-22T10:05:00Z",
};
const clients: QueryClient[] = [];
function client() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(c);
  return c;
}
afterEach(() => {
  vi.resetAllMocks();
  for (const c of clients.splice(0)) c.clear();
});

describe("Task Git counters", () => {
  it("shows complete Git counts and commit context independently of transcript history", () => {
    const c = client();
    c.setQueryData(
      taskGitChangesQueryKey(
        "project",
        "chat-worktree",
        task.implementationStartedAt!,
        null,
      ),
      data,
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={c}>
        <dl>
          <TaskGitChangeMetrics chat={chat} task={task} visible />
        </dl>
      </QueryClientProvider>,
    );
    expect(html).toContain("Files changed");
    expect(html).toContain("Lines changed");
    expect(html).not.toContain("Recorded lines");
    expect(html).toContain(">12</dd>");
    expect(html).toContain("+234");
    expect(html).toContain("−56");
    expect(html).toContain("3 commits · 2 uncommitted");
    expect(html).toContain("other processes");
  });

  it("uses the task dashboard's worktree binding and execution time window", async () => {
    vi.mocked(runProtectedRepositoryOperation).mockResolvedValue(data);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client()}>
          <dl>
            <TaskGitChangeMetrics
              chat={chat}
              task={task}
              visible
              worktreeId="task-worktree"
            />
          </dl>
        </QueryClientProvider>,
      );
    });
    expect(runProtectedRepositoryOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: "project",
        worktreeId: "task-worktree",
        type: "git.change-summary",
        arguments: { since: task.implementationStartedAt, until: null },
      }),
    );
    await act(async () => renderer.unmount());
  });

  it("does not claim zero changes when the worker cannot read Git", async () => {
    vi.mocked(runProtectedRepositoryOperation).mockRejectedValue(
      new Error("Worker offline"),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client()}>
          <dl>
            <TaskGitChangeMetrics chat={chat} task={task} visible />
          </dl>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain("Git stats unavailable");
    expect(output).toContain("Worker offline");
    expect(output).not.toContain("0 added lines");
    await act(async () => renderer.unmount());
  });

  it("does not issue Git requests for hidden or direct-folder task views", async () => {
    for (const props of [
      { visible: false },
      { visible: true, worktreeId: null },
    ]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={client()}>
            <dl>
              <TaskGitChangeMetrics chat={chat} task={task} {...props} />
            </dl>
          </QueryClientProvider>,
        );
      });
      await act(async () => renderer.unmount());
    }
    expect(runProtectedRepositoryOperation).not.toHaveBeenCalled();
  });
});
