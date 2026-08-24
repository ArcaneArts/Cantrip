import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitWorkbenchToolbar,
  gitWorkbenchDialogActions,
  gitWorkbenchNavigationTools,
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
  it("keeps dialog launchers out of the desktop navigation tabs", () => {
    const markup = renderToStaticMarkup(
      <GitWorkbenchToolbar disabled={false} tools={toolStates()} />,
    );

    let previousIndex = -1;
    for (const { label } of gitWorkbenchNavigationTools) {
      const index = markup.indexOf(label);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    for (const { label } of gitWorkbenchDialogActions) {
      expect(markup).not.toContain(label);
    }
    expect(markup.match(/<button/g)).toHaveLength(
      gitWorkbenchNavigationTools.length + 1,
    );
    expect(markup).toContain('aria-label="Open Git history actions"');
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
    expect(markup.match(/disabled=""/g)).toHaveLength(
      gitWorkbenchNavigationTools.length + 1,
    );
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
