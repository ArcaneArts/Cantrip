import { describe, expect, it } from "vitest";

import { explorerCreateSchema } from "../src/index.js";

describe("explorer create schema", () => {
  it("keeps normal Explorers layout-backed by default", () => {
    expect(explorerCreateSchema.parse({})).toMatchObject({
      title: "Explorer",
    });
  });

  it("accepts a resource-only Explorer for the project sidebar", () => {
    expect(
      explorerCreateSchema.parse({ attachToTabLayout: false }),
    ).toMatchObject({
      attachToTabLayout: false,
      title: "Explorer",
    });
  });
});
