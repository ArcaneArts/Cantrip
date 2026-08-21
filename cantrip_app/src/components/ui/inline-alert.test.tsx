import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InlineAlert } from "./inline-alert";

describe("InlineAlert", () => {
  it("uses alert semantics and shared error styling for errors", () => {
    const markup = renderToStaticMarkup(
      <InlineAlert tone="error">Could not load repositories.</InlineAlert>,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-tone="error"');
    expect(markup).toContain("border-destructive/30");
    expect(markup).toContain("Could not load repositories.");
  });

  it("uses status semantics for non-error information", () => {
    const markup = renderToStaticMarkup(
      <InlineAlert tone="warning" size="sm" icon={false}>
        This action may take a while.
      </InlineAlert>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain("text-xs");
    expect(markup).not.toContain("lucide");
  });

  it("shows Error messages and a stable fallback for unknown failures", () => {
    const errorMarkup = renderToStaticMarkup(
      <InlineAlert tone="error" error={new Error("Network unavailable")} />,
    );
    const fallbackMarkup = renderToStaticMarkup(
      <InlineAlert
        tone="error"
        error={{ status: 500 }}
        fallback="Request failed"
      />,
    );

    expect(errorMarkup).toContain("Network unavailable");
    expect(fallbackMarkup).toContain("Request failed");
  });
});
