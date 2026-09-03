import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dialog } from "@/components/ui/dialog";

import {
  GitMobileInspectorClose,
  gitMobileInspectorClassName,
} from "./git-mobile-inspector";

describe("mobile Git inspectors", () => {
  it("fill the narrow viewport and return to a bounded desktop dialog", () => {
    expect(gitMobileInspectorClassName).toContain("fixed inset-0");
    expect(gitMobileInspectorClassName).toContain("h-[100svh]");
    expect(gitMobileInspectorClassName).toContain("w-screen");
    expect(gitMobileInspectorClassName).toContain("overflow-hidden");
    expect(gitMobileInspectorClassName).toContain("md:relative");
    expect(gitMobileInspectorClassName).toContain("md:rounded-xl");
  });

  it("renders a large mobile back target and a desktop close affordance", () => {
    const markup = renderToStaticMarkup(
      <Dialog open>
        <GitMobileInspectorClose label="Back to issues" />
      </Dialog>,
    );

    expect(markup).toContain('aria-label="Back to issues"');
    expect(markup).toContain("size-10");
    expect(markup).toContain("md:size-8");
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("md:block");
  });
});
