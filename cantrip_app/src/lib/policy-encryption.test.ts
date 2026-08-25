import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openPolicyWireDetail,
  protectPolicyCreate,
  protectPolicyUpdate,
} from "./policy-encryption";

const ownerId = "owner-policy-encryption";
const serverId = "server-policy-encryption";
const timestamp = "2026-08-20T00:00:00.000Z";

function session(): ClientSessionContext {
  return {
    serverId,
    user: { id: ownerId },
  } as ClientSessionContext;
}

function service() {
  const result = new ClientEncryptionService();
  result.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 3,
  });
  return result;
}

describe("client policy encryption", () => {
  it("protects creates and updates before opening server wire records", async () => {
    const client = service();
    const options = { service: client, session };
    const created = await protectPolicyCreate(
      {
        key: "sentinel-policy",
        name: "Sentinel policy",
        summary: "Keep semantic policy fields opaque.",
        bodyMarkdown: "# Sentinel policy\n\nDo not send this plaintext.",
        enabled: true,
        mandatory: false,
        audience: "both",
      },
      null,
      options,
    );
    const wire = {
      id: created.id,
      content: created.content,
      audience: created.audience,
      enabled: created.enabled,
      mandatory: created.mandatory,
      position: 0,
      templateKey: created.templateKey,
      rowVersion: 1,
      workspaceAssignmentCount: 0,
      projectAssignmentCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(JSON.stringify(created)).not.toContain("Sentinel policy");
    const opened = await openPolicyWireDetail(wire, options);
    expect(opened).toMatchObject({
      key: "sentinel-policy",
      name: "Sentinel policy",
      bodyMarkdown: "# Sentinel policy\n\nDo not send this plaintext.",
      audience: "both",
    });

    const updated = await protectPolicyUpdate(
      created.id,
      opened,
      {
        rowVersion: 1,
        summary: "Updated private summary.",
        audience: "chat",
      },
      options,
    );
    expect(updated.audience).toBe("chat");
    expect(JSON.stringify(updated)).not.toContain("Updated private summary.");
    await expect(
      openPolicyWireDetail(
        {
          ...wire,
          content: {
            ...wire.content,
            ...updated.content,
          },
          rowVersion: 2,
        },
        options,
      ),
    ).resolves.toMatchObject({ summary: "Updated private summary." });
  });
});
