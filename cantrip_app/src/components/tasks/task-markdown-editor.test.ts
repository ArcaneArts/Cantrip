import { describe, expect, it } from "vitest";

import {
  shouldEmitTaskMarkdownChange,
  shouldSyncTaskMarkdown,
} from "./task-markdown-editor";

describe("Task Markdown editor state", () => {
  it("does not dirty a Task when the editor only normalizes initial Markdown", () => {
    expect(shouldEmitTaskMarkdownChange(true)).toBe(false);
    expect(shouldEmitTaskMarkdownChange(false)).toBe(true);
  });

  it("only replaces editor content when the server or conflict reload changes it", () => {
    expect(shouldSyncTaskMarkdown("# Plan", "# Plan")).toBe(false);
    expect(shouldSyncTaskMarkdown("# Reloaded", "# Local edit")).toBe(true);
  });
});
