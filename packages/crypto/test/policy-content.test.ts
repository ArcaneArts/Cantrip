import { describe, expect, it } from "vitest";

import {
  CantripDecryptionError,
  decryptPolicyBodyContent,
  decryptPolicySummaryContent,
  encryptPolicyContent,
  randomBytes,
} from "../src/index.js";

const ownerId = "owner-1";
const policyId = "00000000-0000-4000-8000-000000000101";
const keyRevision = 2;
const summary = {
  version: 1 as const,
  key: "sentinel-policy",
  name: "Sentinel private policy",
  summary: "Never reveal sentinel policy text to the server.",
};
const body = {
  version: 1 as const,
  bodyMarkdown: "# Sentinel private policy\n\nKeep this body encrypted.",
};

describe("policy content encryption", () => {
  it("round-trips policy content without exposing semantic plaintext", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptPolicyContent({
      ownerId,
      policyId,
      keyRevision,
      componentKey,
      summary,
      body,
    });

    expect(JSON.stringify(encrypted)).not.toContain("Sentinel");
    expect(encrypted.keyBlindIndex).toHaveLength(43);
    await expect(
      decryptPolicySummaryContent({
        ownerId,
        policyId,
        keyRevision,
        componentKey,
        encrypted: encrypted.protectedSummary,
      }),
    ).resolves.toEqual(summary);
    await expect(
      decryptPolicyBodyContent({
        ownerId,
        policyId,
        keyRevision,
        componentKey,
        encrypted: encrypted.protectedBody,
      }),
    ).resolves.toEqual(body);
  });

  it("binds ciphertext to its owner, row, field, and revision", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptPolicyContent({
      ownerId,
      policyId,
      keyRevision,
      componentKey,
      summary,
      body,
    });
    const base = {
      ownerId,
      policyId,
      keyRevision,
      componentKey,
      encrypted: encrypted.protectedSummary,
    };

    await expect(
      decryptPolicySummaryContent({ ...base, ownerId: "owner-2" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPolicySummaryContent({ ...base, policyId: `${policyId}-other` }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPolicySummaryContent({ ...base, keyRevision: keyRevision + 1 }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPolicyBodyContent({
        ...base,
        encrypted: encrypted.protectedSummary,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
