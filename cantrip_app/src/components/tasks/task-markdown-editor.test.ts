import { describe, expect, it } from "vitest";

import {
  shouldEmitTaskMarkdownChange,
  shouldSyncTaskMarkdown,
} from "./task-markdown-editor";
import editorStyles from "./task-markdown-editor.css?raw";

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

describe("Task Markdown toolbar surface", () => {
  it("leaves the shell as the only Pro Mode tint and blur layer", () => {
    const rule = editorStyles.match(
      /:root\.pro-mode \.cantrip-task-markdown-editor \.cantrip-task-markdown-toolbar\s*\{([^}]+)\}/,
    )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toContain("background: transparent;");
    expect(rule).toContain("-webkit-backdrop-filter: none;");
    expect(rule).toContain("backdrop-filter: none;");
    expect(rule).not.toContain("color-mix");
  });

  it("retains the separate toolbar surface outside Pro Mode", () => {
    const rule = editorStyles.match(
      /\n\.cantrip-task-markdown-editor \.cantrip-task-markdown-toolbar\s*\{([^}]+)\}/,
    )?.[1];
    expect(rule).toContain(
      "background: color-mix(in oklab, var(--background) 88%, transparent);",
    );
    expect(rule).toContain("backdrop-filter: blur(18px);");
  });
});
