import type { GitLfsFile, GitLfsStatus } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { lfsAvailabilityLabel, lfsFileStateLabel } from "./git-lfs-panel";

const status: GitLfsStatus = {
  available: true,
  version: "git-lfs/3.7.0",
  message: null,
  patterns: [],
  files: [],
  filesTruncated: false,
  missingObjects: 0,
  pendingPaths: [],
  locks: [],
  locksTruncated: false,
  locksCached: true,
  lockError: null,
  generatedAt: "2026-08-10T12:00:00.000Z",
};

const file: GitLfsFile = {
  path: "assets/design.psd",
  oid: "a".repeat(64),
  size: 42,
  checkedOut: true,
  downloaded: true,
  status: null,
};

describe("Git LFS repository controls", () => {
  it("summarizes availability and pointer state", () => {
    expect(lfsAvailabilityLabel(status)).toBe("ready");
    expect(lfsAvailabilityLabel({ ...status, missingObjects: 2 })).toBe(
      "2 missing",
    );
    expect(lfsFileStateLabel(file)).toBe("materialized");
    expect(lfsFileStateLabel({ ...file, downloaded: false })).toBe(
      "object missing",
    );
    expect(lfsFileStateLabel({ ...file, status: "M" })).toBe("working tree M");
  });
});
