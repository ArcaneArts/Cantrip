import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RepositoryGraphSurface,
  type RepositoryGraphSurfaceProps,
} from "./repository-graph-surface";

const nodes: RepositoryGraphSurfaceProps["nodes"] = [
  {
    color: "purple",
    id: "root",
    kind: "directory",
    label: "repository",
    parentId: null,
    path: "",
    radius: 10,
  },
  {
    accessibleDescription: "TypeScript source file",
    color: "cyan",
    id: "app",
    kind: "file",
    label: "app.ts",
    parentId: "root",
    path: "src/app.ts",
    radius: 6,
  },
];

describe("RepositoryGraphSurface", () => {
  it("provides semantic controls and a bounded canvas-backed scene", () => {
    const markup = renderToStaticMarkup(
      <RepositoryGraphSurface nodes={nodes} selectedNodeId="app" />,
    );
    expect(markup).toContain("data-repository-graph-surface");
    expect(markup).toContain("interactive repository graph");
    expect(markup).toContain("touch-action:none");
    expect(markup).toContain("Fit repository graph to view");
    expect(markup).toContain("Reset repository graph rotation");
    expect(markup).toContain("TypeScript source file");
    expect(markup).not.toContain("data-repository-graph-node-id");
  });
});
