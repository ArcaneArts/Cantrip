import type { BrowserSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { browserUpdateForPageState } from "./browser-page-state";

const browser: BrowserSummary = {
  id: "browser-1",
  projectId: "project-1",
  title: "Browser",
  position: 0,
  stateRevision: 1,
  url: "https://example.com/",
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

describe("browserUpdateForPageState", () => {
  it("synchronizes the first page title and URL", () => {
    expect(
      browserUpdateForPageState(browser, {
        previousTitle: null,
        title: "Cantrip docs",
        url: "https://cantrip.art/docs",
      }),
    ).toEqual({ title: "Cantrip docs", url: "https://cantrip.art/docs" });
  });

  it("continues automatic titles but preserves a manual tab name", () => {
    expect(
      browserUpdateForPageState(
        { ...browser, title: "Cantrip docs" },
        {
          previousTitle: "Cantrip docs",
          title: "Cantrip settings",
          url: browser.url,
        },
      ),
    ).toEqual({ title: "Cantrip settings" });
    expect(
      browserUpdateForPageState(
        { ...browser, title: "Research" },
        {
          previousTitle: "Cantrip docs",
          title: "Cantrip settings",
          url: browser.url,
        },
      ),
    ).toBeNull();
  });
});
