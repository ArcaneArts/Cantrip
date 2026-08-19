import { describe, expect, it } from "vitest";

import { folderNameFromPath } from "./folder-project-dialog";

describe("folderNameFromPath", () => {
  it("derives names from Unix and Windows folder paths", () => {
    expect(folderNameFromPath("/Users/example/Cantrip/")).toBe("Cantrip");
    expect(folderNameFromPath("C:\\code\\Cantrip\\")).toBe("Cantrip");
  });
});
