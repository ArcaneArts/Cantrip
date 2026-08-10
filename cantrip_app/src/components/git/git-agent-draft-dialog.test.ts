import { describe, expect, it } from "vitest";

import { gitAgentTaskLabel } from "./git-agent-draft-dialog";

describe("Git agent draft presentation", () => {
  it("labels change summaries and commit drafts distinctly", () => {
    expect(gitAgentTaskLabel("summarize-changes")).toBe("Summarize changes");
    expect(gitAgentTaskLabel("draft-commit-message")).toBe(
      "Draft commit message",
    );
  });
});
