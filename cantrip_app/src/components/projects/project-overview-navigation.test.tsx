import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectOverviewNavigation } from "./project-overview-navigation";

describe("project overview navigation", () => {
  it("puts Overview before the reusable Git sections", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewNavigation
        activeTab="overview"
        githubEnabled
        gitEnabled
        onTabChange={() => undefined}
      />,
    );

    expect(markup.indexOf(">Overview<")).toBeLessThan(
      markup.indexOf(">History<"),
    );
    expect(markup).toContain(">Issues<");
    expect(markup).toContain(">PRs<");
    expect(markup).toContain(">Graph<");
  });

  it("keeps the legacy Git tab strip free of an Overview entry", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewNavigation
        activeTab="history"
        githubEnabled
        gitEnabled
        includeOverview={false}
        onTabChange={() => undefined}
      />,
    );

    expect(markup).not.toContain(">Overview<");
    expect(markup).toContain(">History<");
  });
});
