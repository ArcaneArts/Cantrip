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
});
