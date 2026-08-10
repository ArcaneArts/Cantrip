import type { GitRecoveryCandidate } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { defaultRecoveryBranch, recoveryAction } from "./git-recovery-dialog";

const candidate: GitRecoveryCandidate = {
  kind: "reflog",
  selector: "HEAD@{0}",
  hash: "1".repeat(40),
  shortHash: "1".repeat(8),
  action: "reset",
  subject: "reset: moving to HEAD~1",
  explanation: "HEAD was reset.",
  actorName: "Cantrip Test",
  actorEmail: "test@cantrip.art",
  occurredAt: "2026-08-10T12:00:00.000Z",
};

describe("Git recovery dialog", () => {
  it("creates stable, user-editable recovery branch defaults", () => {
    expect(defaultRecoveryBranch(candidate)).toBe(
      "recovery/2026-08-10-11111111",
    );
  });

  it("builds only complete recovery actions", () => {
    expect(
      recoveryAction("createBranch", candidate.hash, " recovery/lost ", "soft"),
    ).toEqual({
      type: "createBranch",
      target: candidate.hash,
      branch: "recovery/lost",
    });
    expect(
      recoveryAction("restoreBranch", candidate.hash, "", "mixed"),
    ).toBeNull();
    expect(recoveryAction("reset", candidate.hash, "", "hard")).toEqual({
      type: "reset",
      target: candidate.hash,
      mode: "hard",
    });
  });
});
