import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectSurfaceCreateMenu,
  projectSurfaceCreateDefinitions,
  projectSurfaceCreateOptions,
} from "./project-surface-create-menu";

describe("project surface creation menu", () => {
  it("defines every project surface once in display order", () => {
    expect(projectSurfaceCreateDefinitions).toEqual([
      { kind: "chat", label: "Chat" },
      { kind: "terminal", label: "Terminal" },
      { kind: "explorer", label: "Explorer" },
      { kind: "code", label: "Code" },
      { kind: "browser", label: "Browser" },
      { kind: "history", label: "History" },
      { kind: "issues", label: "Issues" },
      { kind: "remote-desktop", label: "Remote Desktop" },
    ]);
  });

  it("marks only actively creating surface kinds as disabled", () => {
    const options = projectSurfaceCreateOptions(
      new Set(["terminal", "issues"]),
    );

    expect(
      options.filter(({ disabled }) => disabled).map(({ kind }) => kind),
    ).toEqual(["terminal", "issues"]);
    expect(options.find(({ kind }) => kind === "chat")?.disabled).toBe(false);
  });

  it("leaves every option enabled at the empty-set boundary", () => {
    expect(
      projectSurfaceCreateOptions().every(({ disabled }) => !disabled),
    ).toBe(true);
  });

  it("preserves the caller-provided trigger", () => {
    const markup = renderToStaticMarkup(
      <ProjectSurfaceCreateMenu
        onCreate={vi.fn()}
        trigger={<button aria-label="Add project surface" />}
      />,
    );

    expect(markup).toContain('aria-label="Add project surface"');
    expect(markup).toContain('data-state="closed"');
  });
});
