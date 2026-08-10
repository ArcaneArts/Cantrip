import { describe, expect, it } from "vitest";

import { commitFileStatusLabel, signatureLabel } from "./git-commit-inspector";

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
      }),
    ).toBe("Verified signature from Cantrip Maintainer");
    expect(
      signatureLabel({
        status: "valid-unknown",
        signer: null,
        key: null,
        fingerprint: null,
      }),
    ).toContain("untrusted");
    expect(
      signatureLabel({
        status: "unsigned",
        signer: null,
        key: null,
        fingerprint: null,
      }),
    ).toBe("Unsigned commit");
  });
});
