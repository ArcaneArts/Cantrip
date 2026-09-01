import { describe, expect, it } from "vitest";

import {
  createAnonymousRecoveryArtifact,
  encodeBase64Url,
  generateAccountMasterKey,
  openAnonymousRecoveryArtifact,
} from "../src/index.js";

describe("anonymous recovery artifacts", () => {
  it("round-trips an Account Master Key without serializing it in plaintext", async () => {
    const accountMasterKey = generateAccountMasterKey();
    const artifact = await createAnonymousRecoveryArtifact({
      accountMasterKey,
      masterKeyRevision: 3,
      ownerId: "owner-1",
      serverId: "server-1",
    });

    expect(JSON.stringify(artifact)).not.toContain(
      encodeBase64Url(accountMasterKey),
    );
    await expect(openAnonymousRecoveryArtifact(artifact)).resolves.toEqual(
      accountMasterKey,
    );
  });

  it.each([
    ["server", { serverId: "server-2" }],
    ["owner", { ownerId: "owner-2" }],
    [
      "secret",
      { recoverySecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ],
  ])(
    "rejects a recovery artifact with a changed %s binding",
    async (_, patch) => {
      const artifact = await createAnonymousRecoveryArtifact({
        accountMasterKey: generateAccountMasterKey(),
        masterKeyRevision: 1,
        ownerId: "owner-1",
        serverId: "server-1",
      });

      await expect(
        openAnonymousRecoveryArtifact({ ...artifact, ...patch }),
      ).rejects.toThrow();
    },
  );
});
