import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GlobalContentHost } from "./global-content-host";

function render(projects: Record<string, unknown>, extra = {}) {
  return renderToStaticMarkup(
    <GlobalContentHost bindings={{ appMode: "ide", projects, ...extra }} />,
  );
}

describe("project startup presentation", () => {
  it.each([false, true])(
    "shows loading rather than onboarding (popout=%s)",
    (isPopout) => {
      const markup = render({ isPending: true }, { isPopout });
      expect(markup).toContain("data-cantrip-loading");
      expect(markup).not.toContain("Add your first project");
      expect(markup).not.toContain("New project");
    },
  );

  it("keeps loading until startup navigation selects the loaded project", () => {
    expect(render({ data: [{ id: "project-a" }], isSuccess: true })).toContain(
      "data-cantrip-loading",
    );
  });

  it("offers project creation after the project list is confirmed empty", () => {
    const markup = render({ data: [], isSuccess: true });
    expect(markup).toContain("Add your first project");
    expect(markup).not.toContain("data-cantrip-loading");
  });

  it("does not claim an empty project list when loading failed", () => {
    const markup = render({
      isError: true,
      error: new Error("Connection lost"),
    });
    expect(markup).toContain("Could not load projects");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Add your first project");
  });

  it("finishes loading a popout whose project is no longer in the list", () => {
    const markup = render(
      { data: [{ id: "different-project" }], isSuccess: true },
      { isPopout: true },
    );
    expect(markup).toContain("Project is unavailable");
    expect(markup).not.toContain("data-cantrip-loading");
    expect(markup).not.toContain("Add your first project");
  });
});
