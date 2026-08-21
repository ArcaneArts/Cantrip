import { Folder } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContentEmpty, ContentLoading } from "./content-state";

describe("content states", () => {
  it("announces loading content and exposes its visible label", () => {
    const markup = renderToStaticMarkup(
      <ContentLoading label="Loading repositories…" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-slot="content-loading"');
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Loading repositories…");
  });

  it("builds rich empty content on the existing EmptyState primitive", () => {
    const markup = renderToStaticMarkup(
      <ContentEmpty
        icon={<Folder />}
        title="No repositories"
        description="Add a repository to continue."
        actions={<button type="button">Add repository</button>}
      />,
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain('data-slot="empty-state-icon"');
    expect(markup).toContain("No repositories");
    expect(markup).toContain("Add a repository to continue.");
    expect(markup).toContain("Add repository</button>");
  });

  it("renders a compact message when title, icon, and actions are omitted", () => {
    const markup = renderToStaticMarkup(
      <ContentEmpty description="Nothing matched." />,
    );

    expect(markup).toContain("Nothing matched.");
    expect(markup).toContain("mt-0");
    expect(markup).not.toContain('data-slot="empty-state-icon"');
    expect(markup).not.toContain('data-slot="empty-state-title"');
  });
});
