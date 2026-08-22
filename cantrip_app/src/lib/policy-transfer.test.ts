import {
  POLICY_KEY_LIMIT,
  POLICY_LIMIT,
  policyCreateSchema,
} from "@cantrip/protocol/policies";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createPolicyBundle,
  parsePolicyFile,
  parsePolicyImport,
  preparePolicyImports,
  serializePolicyFile,
} from "./policy-transfer";

const policy = policyCreateSchema.parse({
  key: "manual-change-protocol",
  name: "Manual Change Protocol",
  summary: "Use an isolated worktree and pull request.",
  bodyMarkdown: "# Manual changes\n\nAlways verify the result.",
  enabled: true,
  mandatory: true,
});

describe("policy transfer files", () => {
  it("round-trips portable policy content without server metadata", () => {
    const serialized = serializePolicyFile(policy);

    expect(parsePolicyFile(serialized, "manual-change-protocol.json")).toEqual(
      policy,
    );
    expect(JSON.parse(serialized)).toEqual({
      format: "cantrip-policy",
      version: 1,
      policy,
    });
  });

  it("rejects malformed, unknown-version, and extended policy files", () => {
    expect(() => parsePolicyFile("not json", "broken.json")).toThrow(
      "broken.json: not valid JSON",
    );
    expect(() =>
      parsePolicyFile(
        JSON.stringify({
          format: "cantrip-policy",
          version: 2,
          policy,
        }),
        "future.json",
      ),
    ).toThrow("unsupported policy file version 2");
    expect(() =>
      parsePolicyFile(
        JSON.stringify({
          format: "cantrip-policy",
          version: 1,
          policy: { ...policy, id: "server-owned" },
        }),
        "metadata.json",
      ),
    ).toThrow("invalid policy content");
  });

  it("creates an importable ZIP bundle with a readable manifest", async () => {
    const second = { ...policy, key: "review-policy", name: "Review policy" };
    const bundle = await createPolicyBundle([policy, second]);
    const entries = unzipSync(bundle);

    expect(JSON.parse(strFromU8(entries["manifest.json"]!))).toMatchObject({
      format: "cantrip-policy-bundle",
      version: 1,
      policyCount: 2,
    });
    await expect(parsePolicyImport("policies.zip", bundle)).resolves.toEqual([
      policy,
      second,
    ]);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        "policies/001-manual-change-protocol.json",
        "policies/002-review-policy.json",
      ]),
    );
  });

  it("imports ordinary ZIPs containing multiple portable JSON files", async () => {
    const second = { ...policy, key: "review-policy", name: "Review policy" };
    const archive = zipSync({
      "one.json": strToU8(serializePolicyFile(policy)),
      "nested/two.json": strToU8(serializePolicyFile(second)),
      "notes.txt": strToU8("ignored"),
    });

    await expect(parsePolicyImport("custom.zip", archive)).resolves.toEqual([
      second,
      policy,
    ]);
  });

  it("renames duplicate keys without exceeding the key length limit", () => {
    const longKey = "a".repeat(POLICY_KEY_LIMIT);
    const prepared = preparePolicyImports(
      [
        { ...policy, key: longKey },
        { ...policy, key: longKey, name: "Another policy" },
      ],
      [{ key: longKey }],
    );

    expect(prepared.renamedCount).toBe(2);
    expect(prepared.policies.map(({ key }) => key)).toEqual([
      `${"a".repeat(POLICY_KEY_LIMIT - 2)}-2`,
      `${"a".repeat(POLICY_KEY_LIMIT - 2)}-3`,
    ]);
    expect(
      prepared.policies.every(({ key }) => key.length <= POLICY_KEY_LIMIT),
    ).toBe(true);
  });

  it("refuses imports that would exceed the server policy limit", () => {
    const existing = Array.from({ length: POLICY_LIMIT }, (_, index) => ({
      key: `existing-${index}`,
    }));

    expect(() => preparePolicyImports([policy], existing)).toThrow(
      `Only 0 more policies can be imported (limit ${POLICY_LIMIT})`,
    );
  });
});
