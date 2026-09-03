import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitPatchView, gitDiffImagePreviewFromUrl } from "./git-patch-view";

const patch = [
  "@@ -1,2 +1,2 @@",
  " unchanged",
  "-old value",
  "+new value",
].join("\n");

function render(onCommentRange?: () => void) {
  return renderToStaticMarkup(
    <GitPatchView
      error={null}
      loading={false}
      newLabel="After"
      oldLabel="Before"
      onClose={() => undefined}
      onCommentRange={onCommentRange}
      patch={patch}
      path="src/example.ts"
      subtitle="revision patch"
      truncated={false}
    />,
  );
}

describe("GitPatchView", () => {
  it("renders ordinary revision patches as unified text without a table grid", () => {
    const markup = render();
    const text = markup.replace(/<[^>]+>/gu, "");

    expect(text).toContain("old value");
    expect(text).toContain("new value");
    expect(markup).toContain("language-typescript");
    expect(markup).toContain("Split");
    expect(markup).toContain("Hide whitespace-only changes");
    expect(markup).not.toContain("table-header-surface");
    expect(markup).not.toContain("border-l");
    expect(markup).not.toContain("Select left line");
  });

  it("retains old and new line comment targets for pull request reviews", () => {
    const markup = render(() => undefined);

    expect(markup).toContain("Select left line 1 for review");
    expect(markup).toContain("Select right line 1 for review");
  });

  it("recognizes bounded browser image previews without treating text as media", () => {
    expect(
      gitDiffImagePreviewFromUrl(
        "assets/logo.png",
        "https://example.test/logo.png",
      ),
    ).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      url: "https://example.test/logo.png",
    });
    expect(
      gitDiffImagePreviewFromUrl(
        "src/example.ts",
        "https://example.test/example.ts",
      ),
    ).toBeUndefined();
  });
});
