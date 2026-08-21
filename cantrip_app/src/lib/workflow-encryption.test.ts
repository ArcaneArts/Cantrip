import {
  decryptWorkflowContent,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import {
  workflowDefinitionCreateSchema,
  workflowGateProtectedResponseSchema,
  workflowRunCreateSchema,
  workflowRunProtectedInputSchema,
} from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openWorkflowDefinitionWireDetail,
  openWorkflowDefinitionWireSummary,
  protectWorkflowGateDecision,
  protectWorkflowDefinitionCreate,
  protectWorkflowRunCreate,
} from "./workflow-encryption";

const ownerId = "workflow-owner";
const serverId = "workflow-server";
const timestamp = "2026-08-20T00:00:00.000Z";

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

describe("workflow catalog encryption", () => {
  it("protects catalog and definition content with authenticated row binding", async () => {
    const options = { service: service(), session };
    const encrypted = await protectWorkflowDefinitionCreate(
      workflowDefinitionCreateSchema.parse({
        scope: "personal",
        slug: "catalog-sentinel",
        name: "CATALOG_SENTINEL private review",
        description: "CATALOG_SENTINEL private description",
        source: "manual",
        provenance: {
          origin: "cantrip",
          sourceId: "CATALOG_SENTINEL/source",
        },
        revision: {
          graph: {
            version: 1,
            nodes: [
              {
                key: "inspect",
                type: "agent",
                name: "DEFINITION_SENTINEL inspect",
                configuration: {
                  prompt: "DEFINITION_SENTINEL inspect the private project.",
                },
              },
            ],
          },
          source: "manual",
          provenance: {
            origin: "cantrip",
            sourceId: "CATALOG_SENTINEL/source",
          },
        },
      }),
      options,
    );
    expect(JSON.stringify(encrypted)).not.toContain("CATALOG_SENTINEL");
    expect(JSON.stringify(encrypted)).not.toContain("DEFINITION_SENTINEL");
    expect(encrypted.slugBlindIndex).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const wire = {
      id: encrypted.id,
      ownerId,
      projectId: encrypted.projectId,
      scope: encrypted.scope,
      source: encrypted.source,
      content: encrypted.content,
      trustState: encrypted.trustState,
      archivedAt: null,
      latestRevision: {
        id: encrypted.revision.id,
        workflowId: encrypted.id,
        revision: 1,
        source: encrypted.revision.source,
        trustState: encrypted.revision.trustState,
        content: {
          protectedProvenance: encrypted.revision.content.protectedProvenance,
          protectedContentHash: encrypted.revision.content.protectedContentHash,
        },
        createdByUserId: ownerId,
        createdAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await expect(
      openWorkflowDefinitionWireSummary(wire, options),
    ).resolves.toMatchObject({
      slug: "catalog-sentinel",
      name: "CATALOG_SENTINEL private review",
      description: "CATALOG_SENTINEL private description",
      provenance: { sourceId: "CATALOG_SENTINEL/source" },
      latestRevision: {
        provenance: { sourceId: "CATALOG_SENTINEL/source" },
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    await expect(
      openWorkflowDefinitionWireSummary(
        { ...wire, id: crypto.randomUUID() },
        options,
      ),
    ).rejects.toThrow(
      "Protected workflow metadata could not be authenticated.",
    );

    const revisionWire = {
      ...wire.latestRevision,
      content: encrypted.revision.content,
      manifest: {
        version: 1 as const,
        nodes: encrypted.revision.manifest.nodes.map((node) => ({
          ...node,
          createdAt: timestamp,
        })),
        edges: encrypted.revision.manifest.edges.map((edge) => ({
          ...edge,
          createdAt: timestamp,
        })),
      },
    };
    await expect(
      openWorkflowDefinitionWireDetail(
        { workflow: wire, revision: revisionWire },
        options,
      ),
    ).resolves.toMatchObject({
      revision: {
        graph: {
          nodes: [
            {
              name: "DEFINITION_SENTINEL inspect",
              configuration: {
                prompt: "DEFINITION_SENTINEL inspect the private project.",
              },
            },
          ],
        },
      },
    });
  });

  it("protects manual run input before it reaches the server", async () => {
    const encryption = service();
    const options = { service: encryption, session };
    const protectedRun = await protectWorkflowRunCreate(
      workflowRunCreateSchema.parse({
        workflowRevisionId: "revision-1",
        projectId: "project-1",
        structuredInput: { request: "RUN_INPUT_SENTINEL" },
        permissionManifest: {
          filesystem: "read-only",
          network: "none",
          approvalMode: "preauthorized",
          skills: ["private-skill"],
          mcpServers: ["private-mcp"],
          nativeSubagents: false,
        },
        trigger: {
          type: "manual",
          sourceId: null,
          actorType: "user",
          actorId: ownerId,
          deliveredAt: timestamp,
          metadata: {},
        },
        idempotencyKey: "run-once",
      }),
      options,
    );
    expect(JSON.stringify(protectedRun)).not.toContain("RUN_INPUT_SENTINEL");
    expect(protectedRun.permissionManifest.skills).toEqual([]);
    expect(protectedRun.permissionManifest.mcpServers).toEqual([]);
    const componentKey = encryption.componentKey({
      component: "workflow-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    await expect(
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-run",
          recordId: protectedRun.id,
          field: "input",
        },
        keyRevision: 1,
        componentKey,
        encrypted: protectedRun.protectedInput,
        schema: workflowRunProtectedInputSchema,
      }),
    ).resolves.toEqual({
      version: 1,
      input: { request: "RUN_INPUT_SENTINEL" },
    });
  });

  it("protects gate decisions before they reach the server", async () => {
    const encryption = service();
    const gateId = "gate-1";
    const protectedDecision = await protectWorkflowGateDecision(
      gateId,
      {
        decision: "denied",
        reason: "GATE_REASON_SENTINEL",
        idempotencyKey: "gate-decision-once",
      },
      { service: encryption, session },
    );
    expect(protectedDecision.classification).toEqual({ decision: "denied" });
    expect(JSON.stringify(protectedDecision)).not.toContain(
      "GATE_REASON_SENTINEL",
    );
    const componentKey = encryption.componentKey({
      component: "workflow-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    await expect(
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-gate",
          recordId: gateId,
          field: "response",
        },
        keyRevision: 1,
        componentKey,
        encrypted: protectedDecision.protectedResponse,
        schema: workflowGateProtectedResponseSchema,
      }),
    ).resolves.toEqual({
      version: 1,
      decision: "denied",
      reason: "GATE_REASON_SENTINEL",
    });
  });
});
