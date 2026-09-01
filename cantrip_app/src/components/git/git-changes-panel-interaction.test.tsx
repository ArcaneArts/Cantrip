import type { GitStatus } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateProjectWorktreeGitDraft } from "@/lib/api";

import { GitChangesPanel } from "./git-changes-panel";

vi.mock("@/lib/api", () => ({
  generateProjectWorktreeGitDraft: vi.fn(),
  getProjectWorktreeFileDiff: vi.fn(),
  runProjectWorktreeGitAction: vi.fn(),
}));

vi.mock("./git-force-push-dialog", () => ({
  GitForcePushDialog: () => null,
  gitPushRequiresLease: () => false,
}));

const status = {
  branch: "main",
  head: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [
    {
      path: "src/example.ts",
      originalPath: null,
      indexStatus: "M",
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
    },
  ],
  branches: [],
} satisfies GitStatus;

afterEach(() => vi.clearAllMocks());

describe("Git changes commit composer", () => {
  it("writes a generated subject and description into the existing editor", async () => {
    vi.mocked(generateProjectWorktreeGitDraft).mockResolvedValue({
      generationId: "generation-one",
      task: "draft-commit-message",
      text: "Keep commit summaries inline\n\nPopulate the existing commit editor.",
      modelId: "model-one",
      modelName: "Test model",
      providerName: "Test provider",
      worktreeId: "worktree-one",
      generatedAt: "2026-08-31T12:00:00.000Z",
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <GitChangesPanel
            onClose={vi.fn()}
            projectId="project-one"
            status={status}
            worktreeId="worktree-one"
            worktreeName="Primary"
          />
        </QueryClientProvider>,
      );
    });

    const summarize = renderer.root.find(
      (node) => node.type === "button" && node.children.includes("Summarize"),
    );
    await act(async () => {
      summarize.props.onClick();
      await vi.waitFor(() =>
        expect(generateProjectWorktreeGitDraft).toHaveBeenCalledOnce(),
      );
    });

    expect(generateProjectWorktreeGitDraft).toHaveBeenCalledWith(
      "project-one",
      "worktree-one",
      {
        task: "draft-commit-message",
        instructions: null,
        baseRevision: null,
        headRevision: null,
        pullRequestNumber: null,
      },
    );
    expect(
      renderer.root.findByProps({ "aria-label": "Commit message" }).props.value,
    ).toBe(
      "Keep commit summaries inline\n\nPopulate the existing commit editor.",
    );
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
