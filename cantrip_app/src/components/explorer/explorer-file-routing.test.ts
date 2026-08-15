import { describe, expect, it } from "vitest";

import { explorerSurfaceSelectedPath } from "./explorer-file-routing";

describe("Explorer file routing", () => {
  it("keeps desktop Explorer surfaces on the file browser", () => {
    expect(
      explorerSurfaceSelectedPath({
        openFilesExternally: true,
        persistedPath: "src/previous.ts",
      }),
    ).toBeNull();
  });

  it("preserves inline file selection outside desktop", () => {
    expect(
      explorerSurfaceSelectedPath({
        openFilesExternally: false,
        persistedPath: "src/index.ts",
      }),
    ).toBe("src/index.ts");
  });

  it("gives a transient editor target precedence over persisted state", () => {
    expect(
      explorerSurfaceSelectedPath({
        openFilesExternally: false,
        persistedPath: "src/previous.ts",
        transientPath: "src/requested.ts",
      }),
    ).toBe("src/requested.ts");
  });
});
