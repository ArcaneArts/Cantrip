// @vitest-environment jsdom
import {
  githubPullRequestFilesSchema,
  type GithubPullRequestFile,
} from "@cantrip/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitPatchView } from "./git-patch-view";
import { PullRequestFiles } from "./github-pull-request-dialog";

vi.mock("@/lib/use-compact-layout", () => ({
  useCompactLayout: () => false,
  useNarrowViewport: () => false,
}));

const renamed: GithubPullRequestFile = {
  sha: "a".repeat(40),
  path: "test/renamed.f",
  previousPath: "test/test.f",
  status: "renamed",
  additions: 0,
  deletions: 0,
  changes: 0,
  blobUrl: "https://github.com/example/fixture/blob/main/test/renamed.f",
  rawUrl: null,
  patch: null,
  patchTruncated: false,
  viewed: null,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
}
async function renderFile(file: GithubPullRequestFile) {
  const detail = githubPullRequestFilesSchema.parse({
    files: [file],
    filesTruncated: false,
  });
  await render(
    <PullRequestFiles
      detail={detail}
      error={null}
      onAction={async () => {}}
      pending={false}
    />,
  );
}
async function mode(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe("PR file patch availability", () => {
  it("shows a rename without textual changes in both diff modes", async () => {
    await renderFile(renamed);
    for (const layout of ["Split", "Unified"]) {
      await mode(layout);
      expect(container.textContent).toContain("test/test.f → renamed · +0 −0");
      expect(container.textContent).toContain(
        "No textual line changes to display.",
      );
      expect(container.textContent).not.toContain("Binary content");
    }
  });

  it.each([
    { status: "added", additions: 0, deletions: 0, path: "binary.bin" },
    { status: "modified", additions: 12, deletions: 3, path: "large.txt" },
    { status: "renamed", additions: 1, deletions: 0, path: "changed.txt" },
  ])(
    "keeps an omitted patch distinct from confirmed binary data ($path)",
    async (file) => {
      await renderFile({ ...renamed, ...file });
      for (const layout of ["Split", "Unified"]) {
        await mode(layout);
        expect(container.textContent).toContain(
          "GitHub did not provide a text patch for this file.",
        );
        expect(container.textContent).not.toContain(
          "No textual line changes to display.",
        );
        expect(container.textContent).not.toContain("Binary content");
      }
    },
  );

  it("renders deleted text on the left in both modes", async () => {
    await renderFile({
      ...renamed,
      previousPath: null,
      status: "removed",
      additions: 0,
      deletions: 2,
      changes: 2,
      patch: "@@ -1,2 +0,0 @@\n-WQA_DELETED\n-line2",
    });
    for (const layout of ["Split", "Unified"]) {
      await mode(layout);
      expect(container.textContent).toContain("WQA_DELETED");
      expect(
        container.querySelector('[aria-label="Select left line 1 for review"]'),
      ).not.toBeNull();
      expect(container.textContent).not.toContain("Binary content");
    }
  });

  it("keeps supported image previews when GitHub omits their text patch", async () => {
    await renderFile({
      ...renamed,
      path: "image.png",
      previousPath: null,
      status: "added",
      rawUrl: "https://example.invalid/image.png",
    });
    expect(
      container
        .querySelector('img[alt="image.png image preview"]')
        ?.getAttribute("src"),
    ).toBe("https://example.invalid/image.png");
    expect(container.textContent).not.toContain(
      "GitHub did not provide a text patch",
    );
  });

  it("retains the explicit unavailable state for confirmed binary content", async () => {
    await render(
      <GitPatchView
        binary
        error={null}
        loading={false}
        newFile={{
          kind: "binary",
          size: 4,
          mimeType: null,
          base64: null,
          truncated: false,
        }}
        newLabel="binary.bin"
        oldLabel="binary.bin"
        onClose={() => {}}
        path="binary.bin"
        patch={undefined}
        subtitle="Confirmed binary fixture"
        truncated={false}
      />,
    );
    expect(container.textContent).toContain(
      "Binary content cannot be displayed as text.",
    );
  });
});
