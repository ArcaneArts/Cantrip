import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitWorkbenchToolbar,
  gitWorkbenchTools,
  type GitWorkbenchToolStates,
} from "./git-workbench-toolbar";

function toolStates(): GitWorkbenchToolStates {
  const inactive = () => ({ active: false, onSelect: vi.fn() });
  return {
    operations: inactive(),
    repository: inactive(),
    branches: { active: true, onSelect: vi.fn() },
    stashes: inactive(),
    compare: inactive(),
    file: inactive(),
    search: inactive(),
    recovery: inactive(),
  };
}

describe("GitWorkbenchToolbar", () => {
  it("renders every tool in the configured order", () => {
    const markup = renderToStaticMarkup(
      <GitWorkbenchToolbar disabled={false} tools={toolStates()} />,
    );

    let previousIndex = -1;
    for (const { label } of gitWorkbenchTools) {
      const index = markup.indexOf(label);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(markup.match(/<button/g)).toHaveLength(gitWorkbenchTools.length);
  });

  it("surfaces active, attention, and disabled state", () => {
    const tools = toolStates();
    tools.operations.attention = true;
    const markup = renderToStaticMarkup(
      <GitWorkbenchToolbar disabled tools={tools} />,
    );

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="Git tools"');
    expect(markup).toContain('aria-label="Operations active"');
    expect(markup.match(/disabled=""/g)).toHaveLength(gitWorkbenchTools.length);
  });

  it("collapses compact tools into one overflow trigger", () => {
    const markup = renderToStaticMarkup(
      <GitWorkbenchToolbar compact disabled={false} tools={toolStates()} />,
    );

    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Open Git tools"');
    expect(markup).not.toContain("Operations");
    expect(markup).not.toContain("Branches");
  });
});
