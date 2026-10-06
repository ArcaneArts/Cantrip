import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskListBackButton } from "./task-list-back-button";

describe("Task list back button", () => {
  it("exposes an explicit return action", () => {
    const markup = renderToStaticMarkup(
      <TaskListBackButton onBack={() => undefined} />,
    );
    expect(markup).toContain('aria-label="Back to Task list"');
    expect(markup).toContain('title="Back to Task list"');
  });

  it("can keep the hit target inside an edge-to-edge task pane", () => {
    const markup = renderToStaticMarkup(
      <TaskListBackButton className="ml-0" onBack={() => undefined} />,
    );
    const classes = /class="([^"]+)"/.exec(markup)![1]!.split(" ");
    expect(classes).toContain("ml-0");
    expect(classes).not.toContain("-ml-2");
    expect(classes).toContain("size-8");
    expect(markup).toContain('aria-label="Back to Task list"');
  });
});
