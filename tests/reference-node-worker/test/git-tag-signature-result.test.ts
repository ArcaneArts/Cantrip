import type { GitSignature } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { tagSignatureVerificationResult } from "../src/git.js";

const signature: GitSignature = {
  format: "gpg",
  status: "unverifiable",
  verification: "error",
  signer: null,
  key: null,
  fingerprint: null,
  verificationMessage: null,
};

describe("tag verifier result classification", () => {
  it.each([
    [
      0,
      "[GNUPG:] GOODSIG 123 QA\n[GNUPG:] TRUST_FULLY 0 pgp",
      "valid",
      "available",
    ],
    [
      0,
      "[GNUPG:] GOODSIG 123 QA\n[GNUPG:] TRUST_UNDEFINED 0 pgp",
      "valid-unknown",
      "available",
    ],
    [
      0,
      "[GNUPG:] GOODSIG 123 QA\n[GNUPG:] TRUST_NEVER 0 pgp",
      "valid-unknown",
      "available",
    ],
    [1, "[GNUPG:] BADSIG 123 QA", "invalid", "available"],
    [1, "[GNUPG:] EXPSIG 123 QA", "expired", "available"],
    [0, "[GNUPG:] EXPKEYSIG 123 QA", "expired", "available"],
    [0, "[GNUPG:] REVKEYSIG 123 QA", "revoked", "available"],
    [
      1,
      "[GNUPG:] ERRSIG 123 1 10 00 1 9\n[GNUPG:] NO_PUBKEY 123",
      "unverifiable",
      "missing-key",
    ],
    [1, "Verifier failed unexpectedly", "unverifiable", "error"],
  ] as const)(
    "classifies exit %s, output %s as %s/%s",
    (code, output, status, verification) => {
      expect(
        tagSignatureVerificationResult(signature, { code, output }),
      ).toMatchObject({ status, verification });
    },
  );

  it("does not treat a status word inside a signer name as a machine status", () => {
    expect(
      tagSignatureVerificationResult(signature, {
        code: 0,
        output:
          "[GNUPG:] GOODSIG 123 QA TRUST_NEVER\n[GNUPG:] TRUST_FULLY 0 pgp",
      }).status,
    ).toBe("valid");
  });

  it("classifies the full bounded verifier result before truncating display text", () => {
    const result = tagSignatureVerificationResult(signature, {
      code: 1,
      output: "Warning\n".repeat(2000) + "[GNUPG:] BADSIG 123 QA",
    });
    expect(result.status).toBe("invalid");
    expect(result.verificationMessage).toHaveLength(10_000);
  });
});
