import { RefreshCw } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipButton, TooltipProvider } from "./tooltip";

describe("TooltipButton", () => {
  it("uses the shadcn tooltip trigger without a browser-native title", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <TooltipButton size="icon" tooltip="Reload editor">
          <RefreshCw className="size-4" />
        </TooltipButton>
      </TooltipProvider>,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).toContain('aria-label="Reload editor"');
    expect(markup).not.toContain(" title=");
  });

  it("keeps disabled icon buttons hoverable through the tooltip trigger", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <TooltipButton disabled size="icon" tooltip="Editor unavailable">
          <RefreshCw className="size-4" />
        </TooltipButton>
      </TooltipProvider>,
    );

    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('class="inline-flex shrink-0"');
    expect(markup).toContain('aria-label="Editor unavailable"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain(" title=");
  });
});
