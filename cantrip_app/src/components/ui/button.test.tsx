import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, buttonVariants } from "./button";

describe("Button", () => {
  it("uses the shared destructive color contract", () => {
    const classes = buttonVariants({ variant: "destructive" });
    expect(classes).toContain("bg-destructive");
    expect(classes).toContain("text-destructive-foreground");
    expect(classes).not.toContain("text-white");
  });

  it("renders pending actions as busy and disabled", () => {
    const markup = renderToStaticMarkup(
      <Button pending pendingLabel="Deleting…">
        Delete
      </Button>,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-pending="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Deleting…");
    expect(markup).not.toContain(">Delete</button>");
  });

  it("keeps normal actions enabled without busy metadata", () => {
    const markup = renderToStaticMarkup(<Button>Save</Button>);
    expect(markup).toContain(">Save</button>");
    expect(markup).not.toContain("aria-busy");
    expect(markup).not.toContain("data-pending");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/u);
  });
});
