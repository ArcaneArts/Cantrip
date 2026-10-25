import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  UnresolvedProjectSurface,
  unresolvedSurfaceCollection,
} from "./unresolved-project-surface";

const surface = {
  kind: "unresolved",
  title: "My resource",
  tabKey: "opaque-view",
  member: { tabKind: "terminal" },
} as Extract<ProjectSurface, { kind: "unresolved" }>;

it.each([
  [{ isPending: true }, "Loading resource…"],
  [{ isError: true }, "Could not load this resource."],
  [{ isPending: false }, "This resource is currently unavailable."],
])("renders resource status without removing the view", (query, message) => {
  const html = renderToStaticMarkup(
    <UnresolvedProjectSurface
      surface={surface}
      query={{ ...query, refetch: async () => {} }}
      onClose={() => {}}
    />,
  );
  expect(html).toContain('data-unresolved-tab-id="opaque-view"');
  expect(html).toContain(message);
  expect(html).toContain("Close tab");
  expect(html.includes("Retry")).toBe(
    !("isPending" in query && query.isPending),
  );
  expect(unresolvedSurfaceCollection(surface)).toBe("terminals");
});

it("keeps an unstarted query in the loading state without offering retry", () => {
  const html = renderToStaticMarkup(
    <UnresolvedProjectSurface surface={surface} />,
  );
  expect(html).toContain("Loading resource…");
  expect(html).not.toContain("Retry");
  expect(html).not.toContain("Close tab");
});

it.each([
  ["chat", "chats"],
  ["terminal", "terminals"],
  ["explorer", "explorers"],
  ["browser", "browsers"],
  ["code", "codeTabs"],
  ["issues", "projectViews"],
] as const)(
  "routes missing %s resources to their query",
  (tabKind, collection) => {
    expect(
      unresolvedSurfaceCollection({
        ...surface,
        member: { ...surface.member, tabKind },
      }),
    ).toBe(collection);
  },
);
