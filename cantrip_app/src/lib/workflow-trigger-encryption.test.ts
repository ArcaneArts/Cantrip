import { generateAccountMasterKey } from "@cantrip/crypto";
import {
  workflowAutomationTriggerCreateSchema,
  workflowGitEventDeliveryCreateSchema,
} from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openWorkflowAutomationTriggerWire,
  protectWorkflowAutomationTriggerCreate,
  protectWorkflowGitEventDelivery,
} from "./workflow-trigger-encryption";

const ownerId = "trigger-owner";
const serverId = "trigger-server";
const timestamp = "2026-08-21T00:00:00.000Z";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function service() {
  const encryption = new ClientEncryptionService();
  encryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return encryption;
}

describe("workflow trigger encryption", () => {
  it("seals trigger content and authenticates the public routing manifest", async () => {
    const options = { service: service(), session };
    const encrypted = await protectWorkflowAutomationTriggerCreate(
      workflowAutomationTriggerCreateSchema.parse({
        workflowRevisionId: "revision-1",
        projectId: "project-1",
        name: "TRIGGER_NAME_SENTINEL",
        enabled: false,
        structuredInput: { request: "TRIGGER_INPUT_SENTINEL" },
        permissionManifest: {
          filesystem: "read-only",
          network: "none",
          approvalMode: "preauthorized",
          skills: ["private-skill-sentinel"],
          mcpServers: ["private-mcp-sentinel"],
          nativeSubagents: false,
        },
        type: "git",
        configuration: {
          event: "push",
          branchPattern: "PRIVATE_BRANCH_SENTINEL/*",
          minimumIntervalSeconds: 10,
        },
      }),
      options,
    );
    expect(JSON.stringify(encrypted)).not.toMatch(
      /TRIGGER_(?:NAME|INPUT)_SENTINEL|private-(?:skill|mcp)-sentinel|PRIVATE_BRANCH_SENTINEL/u,
    );
    expect(encrypted.permissionManifest.skills).toEqual([]);
    expect(encrypted.permissionManifest.mcpServers).toEqual([]);

    const wire = {
      id: encrypted.id,
      workflowId: "workflow-1",
      workflowRevisionId: encrypted.workflowRevisionId,
      ownerId,
      projectId: encrypted.projectId,
      type: encrypted.type,
      enabled: encrypted.enabled,
      publicConfiguration: encrypted.publicConfiguration,
      protectedName: encrypted.protectedName,
      protectedConfiguration: encrypted.protectedConfiguration,
      protectedInput: encrypted.protectedInput,
      budget: encrypted.budget,
      permissionManifest: encrypted.permissionManifest,
      selectedModelRouteId: encrypted.selectedModelRouteId,
      selectedPermissionProfileId: encrypted.selectedPermissionProfileId,
      nextRunAt: null,
      lastDeliveredAt: null,
      lastRunId: null,
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await expect(
      openWorkflowAutomationTriggerWire(wire, options),
    ).resolves.toMatchObject({
      name: "TRIGGER_NAME_SENTINEL",
      structuredInput: { request: "TRIGGER_INPUT_SENTINEL" },
      configuration: { branchPattern: "PRIVATE_BRANCH_SENTINEL/*" },
    });
    await expect(
      openWorkflowAutomationTriggerWire(
        {
          ...wire,
          publicConfiguration: {
            ...wire.publicConfiguration,
            event: "pull-request",
          },
        },
        options,
      ),
    ).rejects.toThrow(
      "Protected workflow trigger content could not be authenticated.",
    );
  });

  it("seals dynamic Git delivery input and branch with operation binding", async () => {
    const encrypted = await protectWorkflowGitEventDelivery(
      "trigger-1",
      workflowGitEventDeliveryCreateSchema.parse({
        event: "push",
        branch: "DELIVERY_BRANCH_SENTINEL",
        deliveryId: "delivery-1",
        structuredInput: { value: "DELIVERY_INPUT_SENTINEL" },
      }),
      { service: service(), session },
    );
    expect(encrypted).toMatchObject({
      event: "push",
      deliveryId: "delivery-1",
    });
    expect(JSON.stringify(encrypted)).not.toMatch(
      /DELIVERY_(?:BRANCH|INPUT)_SENTINEL/u,
    );
  });
});
