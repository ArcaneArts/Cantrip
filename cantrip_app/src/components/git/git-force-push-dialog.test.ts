import { describe, expect, it } from "vitest";

import {
  gitForcePushConfirmationMatches,
  gitPushRequiresLease,
} from "./git-force-push-dialog";

describe("Git force-push safety", () => {
  it("routes only divergent outgoing history through force-with-lease review", () => {
    expect(gitPushRequiresLease({ ahead: 2, behind: 1 })).toBe(true);
    expect(gitPushRequiresLease({ ahead: 2, behind: 0 })).toBe(false);
    expect(gitPushRequiresLease({ ahead: 0, behind: 2 })).toBe(false);
    expect(gitPushRequiresLease(null)).toBe(false);
  });

  it("requires the exact remote branch confirmation", () => {
    expect(gitForcePushConfirmationMatches("origin/main", "origin/main")).toBe(
      true,
    );
    expect(gitForcePushConfirmationMatches("origin/main", "main")).toBe(false);
    expect(gitForcePushConfirmationMatches("origin/main", "Origin/main")).toBe(
      false,
    );
    expect(gitForcePushConfirmationMatches("", "")).toBe(false);
  });
});
