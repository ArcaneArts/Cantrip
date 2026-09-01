import { describe, expect, it } from "vitest";

import {
  anonymousRecoveryArtifactFileName,
  createAnonymousRecoveryArtifactText,
  parseAnonymousRecoveryArtifactText,
} from "./anonymous-recovery-artifact";
import { ClientEncryptionService } from "./client-encryption";
import { generateAccountMasterKey } from "@cantrip/crypto";

const identity = { ownerId: "owner-1", serverId: "server-1" };
const emptyDeviceStore = {
  delete: () => Promise.resolve(),
  load: () => Promise.resolve(null),
  save: () => Promise.resolve(),
};

describe("anonymous recovery artifact files", () => {
  it("serializes a bounded, versioned bearer recovery file", async () => {
    const service = new ClientEncryptionService(emptyDeviceStore);
    service.setAccountMasterKey({
      accountMasterKey: generateAccountMasterKey(),
      identity,
      masterKeyRevision: 2,
    });

    const text = await createAnonymousRecoveryArtifactText({
      identity,
      service,
    });
    expect(parseAnonymousRecoveryArtifactText(text)).toMatchObject({
      masterKeyRevision: 2,
      ownerId: identity.ownerId,
      purpose: "anonymous-account-recovery",
      serverId: identity.serverId,
      version: 1,
    });
  });

  it("rejects malformed and unbounded recovery files", () => {
    expect(() => parseAnonymousRecoveryArtifactText("not json")).toThrow(
      /invalid or unsupported/iu,
    );
    expect(() =>
      parseAnonymousRecoveryArtifactText("x".repeat(64 * 1_024 + 1)),
    ).toThrow(/too large/iu);
  });

  it("uses a stable, non-identifying file name", () => {
    expect(
      anonymousRecoveryArtifactFileName(new Date("2026-08-31T12:00:00.000Z")),
    ).toBe("cantrip-anonymous-recovery-2026-08-31.cantrip-recovery.json");
  });
});
