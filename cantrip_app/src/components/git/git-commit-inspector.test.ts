import { describe, expect, it } from "vitest";

import {
  commitFileStatusLabel,
  signatureLabel,
  signatureVerificationLabel,
} from "./git-commit-inspector";

describe("Git commit inspector presentation", () => {
  it("labels uncommon commit file states", () => {
    expect(commitFileStatusLabel("renamed")).toBe("Renamed");
    expect(commitFileStatusLabel("type-changed")).toBe("Type changed");
    expect(commitFileStatusLabel("unmerged")).toBe("Unmerged");
    expect(commitFileStatusLabel("unknown")).toBe("Changed");
  });

  it("distinguishes verified, untrusted, and unsigned signatures", () => {
    expect(
      signatureLabel({
        status: "valid",
        signer: "Cantrip Maintainer",
        key: "ABC123",
        fingerprint: null,
        format: "ssh",
        verification: "available",
        verificationMessage: "Good SSH signature",
      }),
    ).toBe("Verified SSH signature from Cantrip Maintainer");
    expect(
      signatureLabel({
        status: "valid-unknown",
        signer: null,
        key: null,
        fingerprint: null,
        format: "gpg",
        verification: "available",
        verificationMessage: null,
      }),
    ).toBe("Valid GPG signature from an untrusted key");
    expect(
      signatureLabel({
        status: "unsigned",
        signer: null,
        key: null,
        fingerprint: null,
        format: null,
        verification: "not-applicable",
        verificationMessage: null,
      }),
    ).toBe("Unsigned commit");
  });

  it("explains worker signature verification prerequisites", () => {
    expect(
      signatureVerificationLabel({
        status: "unverifiable",
        signer: null,
        key: null,
        fingerprint: null,
        format: "ssh",
        verification: "missing-config",
        verificationMessage:
          "gpg.ssh.allowedSignersFile needs to be configured",
      }),
    ).toContain("allowed-signers");
    expect(
      signatureVerificationLabel({
        status: "unverifiable",
        signer: null,
        key: null,
        fingerprint: null,
        format: "gpg",
        verification: "missing-tool",
        verificationMessage: "cannot run gpg",
      }),
    ).toContain("not installed");
  });
});
