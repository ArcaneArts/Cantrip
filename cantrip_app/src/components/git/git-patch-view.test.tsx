import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitPatchView } from "./git-patch-view";

const patch = [
  "@@ -1,2 +1,2 @@",
  " unchanged",
  "-old value",
  "+new value",
].join("\n");

function render(
  onCommentLine?: (line: number, side: "LEFT" | "RIGHT") => void,
) {
  return renderToStaticMarkup(
    <GitPatchView
      error={null}
      loading={false}
      newLabel="After"
      oldLabel="Before"
      onClose={() => undefined}
      onCommentLine={onCommentLine}
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

    expect(markup).toContain("old value");
    expect(markup).toContain("new value");
    expect(markup).not.toContain("table-header-surface");
    expect(markup).not.toContain("border-l");
    expect(markup).not.toContain("Comment on old line");
  });

  it("retains old and new line comment targets for pull request reviews", () => {
    const markup = render(() => undefined);

    expect(markup).toContain("Comment on old line 1");
    expect(markup).toContain("Comment on new line 1");
  });
});
