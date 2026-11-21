import { describe, expect, it } from "vitest";

import { encryptPolicyContent, randomBytes } from "@cantrip/crypto";

import {
  buildEncryptedAgentPolicyContext,
  openPolicyCliDetail,
  openPolicyCliList,
} from "../src/policy-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const ownerId = "owner-1";
const policyId = "00000000-0000-4000-8000-000000000101";
const keyRevision = 1;

describe("worker policy decryption", () => {
  it("opens effective summaries and full CLI detail only inside the worker", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptPolicyContent({
      ownerId,
      policyId,
      keyRevision,
      componentKey,
      summary: {
        version: 1,
        key: "manual-change",
        name: "Manual change",
        summary: "Ask before applying a manual change.",
      },
      body: {
        version: 1,
        bodyMarkdown: "# Manual change\n\nRequest confirmation first.",
      },
    });
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
    } as unknown as WorkerEncryptionService;
    const wirePolicies = {
      policies: [
        {
          id: policyId,
          protectedSummary: encrypted.protectedSummary,
          mandatory: true,
          sources: [{ type: "mandatory" as const }],
        },
      ],
    };

    await expect(
      openPolicyCliList({ policies: wirePolicies, service }),
    ).resolves.toMatchObject({
      policies: [{ key: "manual-change", name: "Manual change" }],
    });
    await expect(
      buildEncryptedAgentPolicyContext({
        policies: wirePolicies,
        projectId: "project-1",
        service,
      }),
    ).resolves.toContain("Ask before applying a manual change.");
    await expect(
      openPolicyCliDetail({
        policy: {
          id: policyId,
          content: encrypted,
          enabled: true,
          mandatory: true,
          position: 0,
          templateKey: null,
          rowVersion: 1,
          workspaceAssignmentCount: 0,
          projectAssignmentCount: 0,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
        service,
      }),
    ).resolves.toEqual({
      policy: {
        key: "manual-change",
        name: "Manual change",
        summary: "Ask before applying a manual change.",
        bodyMarkdown: "# Manual change\n\nRequest confirmation first.",
      },
    });
  });
});
