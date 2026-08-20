import { Folder } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "./empty-state";

describe("EmptyState", () => {
  it("renders consistent empty-state structure with semantic overrides", () => {
    const markup = renderToStaticMarkup(
      <EmptyState className="min-h-80">
        <EmptyStateContent>
          <EmptyStateIcon>
            <Folder />
          </EmptyStateIcon>
          <EmptyStateTitle as="h1">No projects</EmptyStateTitle>
          <EmptyStateDescription>Add a project.</EmptyStateDescription>
          <EmptyStateActions>
            <button type="button">New project</button>
          </EmptyStateActions>
        </EmptyStateContent>
      </EmptyState>,
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain(
      'class="grid flex-1 place-items-center p-6 text-center min-h-80"',
    );
    expect(markup).toContain('<h1 data-slot="empty-state-title"');
    expect(markup).toContain('data-slot="empty-state-description"');
    expect(markup).toContain('data-slot="empty-state-actions"');
  });
});
