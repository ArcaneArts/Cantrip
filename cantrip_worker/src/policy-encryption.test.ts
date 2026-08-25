import { encryptPolicyContent } from "@cantrip/crypto";
import { POLICY_CONTEXT_BYTES_LIMIT } from "@cantrip/protocol/policies";
import { describe, expect, it } from "vitest";

import { buildStandalonePolicyContext } from "./policy-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "standalone-policy-owner";
const componentKey = new Uint8Array(32).fill(17);

function service(): WorkerEncryptionService {
  return {
    ownerId: () => ownerId,
    componentKey: () => ({ key: new Uint8Array(componentKey), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
}

async function policy(bodyMarkdown: string) {
  const id = crypto.randomUUID();
  const content = await encryptPolicyContent({
    ownerId,
    policyId: id,
    keyRevision: 1,
    componentKey,
    summary: {
      version: 1,
      key: "chat-safety",
      name: "Chat safety",
      summary: "Apply the full standalone instructions.",
    },
    body: { version: 1, bodyMarkdown },
  });
  return {
    id,
    protectedSummary: content.protectedSummary,
    protectedBody: content.protectedBody,
  };
}

describe("standalone Policy context", () => {
  it("decrypts and injects full Policy bodies without policy_read", async () => {
    const context = await buildStandalonePolicyContext({
      policies: {
        policies: [await policy("# Rules\n\nKeep standalone data private.")],
      },
      service: service(),
    });

    expect(context).toContain("Policy: Chat safety (chat-safety)");
    expect(context).toContain("Keep standalone data private.");
    expect(context).toContain("policy tools are unavailable");
  });

  it("rejects Policy bodies above the bounded instruction context", async () => {
    await expect(
      buildStandalonePolicyContext({
        policies: {
          policies: [await policy("x".repeat(POLICY_CONTEXT_BYTES_LIMIT))],
        },
        service: service(),
      }),
    ).rejects.toThrow("above the");
  });
});
