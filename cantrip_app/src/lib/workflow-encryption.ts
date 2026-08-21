import {
  clearSensitiveBytes,
  computeBlindLookupTag,
  decryptWorkflowContent,
  deriveLookupKey,
  encryptWorkflowContent,
} from "@cantrip/crypto";
import {
  encryptedWorkflowDefinitionCreateSchema,
  encryptedWorkflowDefinitionUpdateSchema,
  encryptedWorkflowGateDecisionSchema,
  encryptedWorkflowRevisionCreateSchema,
  encryptedWorkflowRunCreateSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionProtectedDescriptionSchema,
  workflowDefinitionProtectedNameSchema,
  workflowDefinitionProtectedProvenanceSchema,
  workflowDefinitionProtectedSlugSchema,
  workflowDefinitionSummarySchema,
  workflowDefinitionUpdateSchema,
  workflowDefinitionWireDetailSchema,
  workflowDefinitionWireSummarySchema,
  workflowRevisionCreateSchema,
  workflowRevisionProtectedContentHashSchema,
  workflowRevisionProtectedDefinitionSchema,
  workflowRevisionProtectedProvenanceSchema,
  workflowRevisionSchema,
  workflowRevisionSummarySchema,
  workflowRevisionWireSchema,
  workflowRevisionWireSummarySchema,
  workflowNodeAttemptSchema,
  workflowApprovalGateSchema,
  workflowApprovalGateWireSchema,
  workflowGateDecisionSchema,
  workflowGateProtectedRequestSchema,
  workflowGateProtectedResponseSchema,
  workflowNodeProtectedInputSchema,
  workflowNodeProtectedResultSchema,
  workflowProtectedErrorSchema,
  workflowRunCreateSchema,
  workflowRunDetailSchema,
  workflowRunNodeItemSchema,
  workflowRunNodeSchema,
  workflowRunProtectedInputSchema,
  workflowRunProtectedResultSchema,
  workflowRunSchema,
  workflowRunWireDetailSchema,
  workflowRunWireSchema,
  type EncryptedWorkflowDefinitionCreate,
  type EncryptedWorkflowDefinitionUpdate,
  type EncryptedWorkflowGateDecision,
  type EncryptedWorkflowRevisionCreate,
  type WorkflowDefinitionCreate,
  type WorkflowDefinitionDetail,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionUpdate,
  type WorkflowDefinitionWireDetail,
  type WorkflowDefinitionWireSummary,
  type WorkflowGateDecision,
  type WorkflowRevision,
  type WorkflowRevisionCreate,
  type WorkflowRevisionSummary,
  type WorkflowRevisionWire,
  type WorkflowRevisionWireSummary,
  type EncryptedWorkflowRunCreate,
  type WorkflowRun,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
  type WorkflowRunWire,
  type WorkflowRunWireDetail,
} from "@cantrip/protocol/workflows";
import type { WorkflowContentOpaque } from "@cantrip/protocol/workflow-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

const component = "workflow-content" as const;
const encoder = new TextEncoder();

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

type EncryptionContext = ReturnType<typeof encryptionContext>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    componentKey: service.componentKey({
      component,
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
  };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalJson(value));
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    try {
      return `sha256:${[...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
    } finally {
      clearSensitiveBytes(digest);
    }
  } finally {
    clearSensitiveBytes(bytes);
  }
}

function blindIndex(input: {
  canonicalValue: string;
  context: EncryptionContext;
  field: "slug" | "content-hash";
  recordKind: "workflow-definition" | "workflow-revision";
}) {
  const lookupKey = deriveLookupKey({
    componentKey: input.context.componentKey,
    ownerId: input.context.ownerId,
    component,
    table: `workflow:${input.recordKind}`,
    field: input.field,
    keyRevision: input.context.keyRevision,
  });
  try {
    return computeBlindLookupTag(lookupKey, input.canonicalValue);
  } finally {
    clearSensitiveBytes(lookupKey);
  }
}

async function protectField<T>(input: {
  content: T;
  context: EncryptionContext;
  field:
    | "slug"
    | "name"
    | "description"
    | "provenance"
    | "content-hash"
    | "definition";
  recordId: string;
  recordKind: "workflow-definition" | "workflow-revision";
  schema: { parse(value: unknown): T };
}) {
  return encryptWorkflowContent({
    ownerId: input.context.ownerId,
    context: {
      recordKind: input.recordKind,
      recordId: input.recordId,
      field: input.field,
    },
    keyRevision: input.context.keyRevision,
    componentKey: input.context.componentKey,
    content: input.content,
    schema: input.schema,
  });
}

async function openField<T>(input: {
  context: EncryptionContext;
  encrypted: WorkflowContentOpaque;
  field:
    | "slug"
    | "name"
    | "description"
    | "provenance"
    | "content-hash"
    | "definition";
  recordId: string;
  recordKind: "workflow-definition" | "workflow-revision";
  schema: { parse(value: unknown): T };
}) {
  return decryptWorkflowContent({
    ownerId: input.context.ownerId,
    context: {
      recordKind: input.recordKind,
      recordId: input.recordId,
      field: input.field,
    },
    keyRevision: input.encrypted.keyRevision,
    componentKey: input.context.componentKey,
    encrypted: input.encrypted,
    schema: input.schema,
  });
}

async function protectRevision(
  raw: WorkflowRevisionCreate,
  id: string,
  context: EncryptionContext,
): Promise<EncryptedWorkflowRevisionCreate> {
  const input = workflowRevisionCreateSchema.parse(raw);
  const contentHash = await sha256(input);
  const nodeIdByKey = new Map(
    input.graph.nodes.map((node) => [node.key, crypto.randomUUID()]),
  );
  const manifest = {
    version: 1 as const,
    nodes: input.graph.nodes.map((node) => ({
      id: nodeIdByKey.get(node.key)!,
      type: node.type,
      mutationMode: node.mutationMode,
      modelRouteId: node.modelRouteId,
      permissionProfileId: node.permissionProfileId,
    })),
    edges: input.graph.edges.map((edge) => ({
      id: crypto.randomUUID(),
      fromNodeId: nodeIdByKey.get(edge.from)!,
      toNodeId: nodeIdByKey.get(edge.to)!,
    })),
  };
  const [protectedProvenance, protectedContentHash, protectedDefinition] =
    await Promise.all([
      protectField({
        content: { version: 1, provenance: input.provenance } as const,
        context,
        field: "provenance",
        recordId: id,
        recordKind: "workflow-revision",
        schema: workflowRevisionProtectedProvenanceSchema,
      }),
      protectField({
        content: { version: 1, contentHash } as const,
        context,
        field: "content-hash",
        recordId: id,
        recordKind: "workflow-revision",
        schema: workflowRevisionProtectedContentHashSchema,
      }),
      protectField({
        content: {
          version: 1,
          graph: input.graph,
          declaredInputs: input.declaredInputs,
          declaredOutputs: input.declaredOutputs,
          defaults: input.defaults,
          permissionRequirements: input.permissionRequirements,
        } as const,
        context,
        field: "definition",
        recordId: id,
        recordKind: "workflow-revision",
        schema: workflowRevisionProtectedDefinitionSchema,
      }),
    ]);
  return encryptedWorkflowRevisionCreateSchema.parse({
    id,
    source: input.source,
    trustState: input.trustState,
    manifest,
    contentBlindIndex: blindIndex({
      canonicalValue: contentHash,
      context,
      field: "content-hash",
      recordKind: "workflow-revision",
    }),
    content: {
      protectedProvenance,
      protectedContentHash,
      protectedDefinition,
    },
  });
}

export async function protectWorkflowDefinitionCreate(
  raw: WorkflowDefinitionCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowDefinitionCreate> {
  const input = workflowDefinitionCreateSchema.parse(raw);
  const context = encryptionContext(options);
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  try {
    const [
      protectedSlug,
      protectedName,
      protectedDescription,
      protectedProvenance,
      revision,
    ] = await Promise.all([
      protectField({
        content: { version: 1, slug: input.slug } as const,
        context,
        field: "slug",
        recordId: id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedSlugSchema,
      }),
      protectField({
        content: { version: 1, name: input.name } as const,
        context,
        field: "name",
        recordId: id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedNameSchema,
      }),
      protectField({
        content: { version: 1, description: input.description } as const,
        context,
        field: "description",
        recordId: id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedDescriptionSchema,
      }),
      protectField({
        content: { version: 1, provenance: input.provenance } as const,
        context,
        field: "provenance",
        recordId: id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedProvenanceSchema,
      }),
      protectRevision(input.revision, revisionId, context),
    ]);
    return encryptedWorkflowDefinitionCreateSchema.parse({
      id,
      projectId: input.projectId,
      scope: input.scope,
      source: input.source,
      trustState: input.trustState,
      slugBlindIndex: blindIndex({
        canonicalValue: input.slug,
        context,
        field: "slug",
        recordKind: "workflow-definition",
      }),
      content: {
        protectedSlug,
        protectedName,
        protectedDescription,
        protectedProvenance,
      },
      revision,
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectWorkflowRevisionCreate(
  raw: WorkflowRevisionCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowRevisionCreate> {
  const context = encryptionContext(options);
  try {
    return await protectRevision(raw, crypto.randomUUID(), context);
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectWorkflowDefinitionUpdate(
  workflowId: string,
  raw: WorkflowDefinitionUpdate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowDefinitionUpdate> {
  const input = workflowDefinitionUpdateSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const content: Record<string, unknown> = {};
    if (input.name !== undefined) {
      content.protectedName = await protectField({
        content: { version: 1, name: input.name } as const,
        context,
        field: "name",
        recordId: workflowId,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedNameSchema,
      });
    }
    if (input.description !== undefined) {
      content.protectedDescription = await protectField({
        content: { version: 1, description: input.description } as const,
        context,
        field: "description",
        recordId: workflowId,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedDescriptionSchema,
      });
    }
    return encryptedWorkflowDefinitionUpdateSchema.parse({
      ...(Object.keys(content).length > 0 ? { content } : {}),
      ...(input.trustState === undefined
        ? {}
        : { trustState: input.trustState }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

async function openRevisionSummaryWithContext(
  raw: WorkflowRevisionWireSummary | WorkflowRevisionWire,
  context: EncryptionContext,
): Promise<WorkflowRevisionSummary> {
  const revision = workflowRevisionWireSummarySchema.parse({
    id: raw.id,
    workflowId: raw.workflowId,
    revision: raw.revision,
    source: raw.source,
    trustState: raw.trustState,
    content: {
      protectedProvenance: raw.content.protectedProvenance,
      protectedContentHash: raw.content.protectedContentHash,
    },
    createdByUserId: raw.createdByUserId,
    createdAt: raw.createdAt,
  });
  const [provenance, contentHash] = await Promise.all([
    openField({
      context,
      encrypted: revision.content.protectedProvenance,
      field: "provenance",
      recordId: revision.id,
      recordKind: "workflow-revision",
      schema: workflowRevisionProtectedProvenanceSchema,
    }),
    openField({
      context,
      encrypted: revision.content.protectedContentHash,
      field: "content-hash",
      recordId: revision.id,
      recordKind: "workflow-revision",
      schema: workflowRevisionProtectedContentHashSchema,
    }),
  ]);
  return workflowRevisionSummarySchema.parse({
    ...revision,
    content: undefined,
    provenance: provenance.provenance,
    contentHash: contentHash.contentHash,
  });
}

export async function openWorkflowRevisionWireSummary(
  raw: WorkflowRevisionWireSummary,
  options: TrustedOptions = {},
): Promise<WorkflowRevisionSummary> {
  const context = encryptionContext(options);
  try {
    return await openRevisionSummaryWithContext(raw, context);
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

async function openRevisionWithContext(
  raw: WorkflowRevisionWire,
  context: EncryptionContext,
): Promise<WorkflowRevision> {
  const revision = workflowRevisionWireSchema.parse(raw);
  const [summary, definition] = await Promise.all([
    openRevisionSummaryWithContext(revision, context),
    openField({
      context,
      encrypted: revision.content.protectedDefinition,
      field: "definition",
      recordId: revision.id,
      recordKind: "workflow-revision",
      schema: workflowRevisionProtectedDefinitionSchema,
    }),
  ]);
  if (
    definition.graph.nodes.length !== revision.manifest.nodes.length ||
    definition.graph.edges.length !== revision.manifest.edges.length
  ) {
    throw new Error(
      "Protected workflow definition does not match its manifest.",
    );
  }
  const nodeIdByKey = new Map<string, string>();
  const nodes = definition.graph.nodes.map((node, position) => {
    const manifestNode = revision.manifest.nodes[position]!;
    if (
      manifestNode.type !== node.type ||
      manifestNode.mutationMode !== node.mutationMode ||
      manifestNode.modelRouteId !== node.modelRouteId ||
      manifestNode.permissionProfileId !== node.permissionProfileId
    ) {
      throw new Error(
        "Protected workflow definition does not match its manifest.",
      );
    }
    nodeIdByKey.set(node.key, manifestNode.id);
    return {
      ...node,
      id: manifestNode.id,
      revisionId: revision.id,
      position,
      createdAt: manifestNode.createdAt,
    };
  });
  const edges = definition.graph.edges.map((edge, position) => {
    const manifestEdge = revision.manifest.edges[position]!;
    if (
      manifestEdge.fromNodeId !== nodeIdByKey.get(edge.from) ||
      manifestEdge.toNodeId !== nodeIdByKey.get(edge.to)
    ) {
      throw new Error(
        "Protected workflow definition does not match its manifest.",
      );
    }
    return {
      ...edge,
      id: manifestEdge.id,
      revisionId: revision.id,
      fromNodeId: manifestEdge.fromNodeId,
      toNodeId: manifestEdge.toNodeId,
      position,
      createdAt: manifestEdge.createdAt,
    };
  });
  return workflowRevisionSchema.parse({
    ...summary,
    graph: definition.graph,
    declaredInputs: definition.declaredInputs,
    declaredOutputs: definition.declaredOutputs,
    defaults: definition.defaults,
    permissionRequirements: definition.permissionRequirements,
    nodes,
    edges,
  });
}

export async function openWorkflowRevisionWire(
  raw: WorkflowRevisionWire,
  options: TrustedOptions = {},
): Promise<WorkflowRevision> {
  const context = encryptionContext(options);
  try {
    return await openRevisionWithContext(raw, context);
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

async function openDefinitionSummaryWithContext(
  raw: WorkflowDefinitionWireSummary,
  context: EncryptionContext,
): Promise<WorkflowDefinitionSummary> {
  const workflow = workflowDefinitionWireSummarySchema.parse(raw);
  const [slug, name, description, provenance, latestRevision] =
    await Promise.all([
      openField({
        context,
        encrypted: workflow.content.protectedSlug,
        field: "slug",
        recordId: workflow.id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedSlugSchema,
      }),
      openField({
        context,
        encrypted: workflow.content.protectedName,
        field: "name",
        recordId: workflow.id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedNameSchema,
      }),
      openField({
        context,
        encrypted: workflow.content.protectedDescription,
        field: "description",
        recordId: workflow.id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedDescriptionSchema,
      }),
      openField({
        context,
        encrypted: workflow.content.protectedProvenance,
        field: "provenance",
        recordId: workflow.id,
        recordKind: "workflow-definition",
        schema: workflowDefinitionProtectedProvenanceSchema,
      }),
      workflow.latestRevision
        ? openRevisionSummaryWithContext(workflow.latestRevision, context)
        : null,
    ]);
  return workflowDefinitionSummarySchema.parse({
    ...workflow,
    content: undefined,
    slug: slug.slug,
    name: name.name,
    description: description.description,
    provenance: provenance.provenance,
    latestRevision,
  });
}

export async function openWorkflowDefinitionWireSummary(
  raw: WorkflowDefinitionWireSummary,
  options: TrustedOptions = {},
): Promise<WorkflowDefinitionSummary> {
  const context = encryptionContext(options);
  try {
    return await openDefinitionSummaryWithContext(raw, context);
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected workflow metadata could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openWorkflowDefinitionWireDetail(
  raw: WorkflowDefinitionWireDetail,
  options: TrustedOptions = {},
): Promise<WorkflowDefinitionDetail> {
  const wire = workflowDefinitionWireDetailSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const [workflow, revision] = await Promise.all([
      openDefinitionSummaryWithContext(wire.workflow, context),
      wire.revision ? openRevisionWithContext(wire.revision, context) : null,
    ]);
    return { workflow, revision };
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected workflow content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectWorkflowRunCreate(
  raw: WorkflowRunCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowRunCreate> {
  const input = workflowRunCreateSchema.parse(raw);
  const { structuredInput, ...metadata } = input;
  const id = crypto.randomUUID();
  const context = encryptionContext(options);
  try {
    return encryptedWorkflowRunCreateSchema.parse({
      ...metadata,
      id,
      permissionManifest: {
        ...input.permissionManifest,
        skills: [],
        mcpServers: [],
      },
      protectedInput: await encryptWorkflowContent({
        ownerId: context.ownerId,
        context: { recordKind: "workflow-run", recordId: id, field: "input" },
        keyRevision: context.keyRevision,
        componentKey: context.componentKey,
        content: { version: 1, input: structuredInput },
        schema: workflowRunProtectedInputSchema,
      }),
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

async function openRuntimeField<T>(input: {
  context: EncryptionContext;
  encrypted: WorkflowContentOpaque;
  field: "input" | "result" | "error";
  recordId: string;
  recordKind:
    | "workflow-run"
    | "workflow-run-node"
    | "workflow-run-node-item"
    | "workflow-attempt";
  schema: { parse(value: unknown): T };
}): Promise<T> {
  return decryptWorkflowContent({
    ownerId: input.context.ownerId,
    context: {
      recordKind: input.recordKind,
      recordId: input.recordId,
      field: input.field,
    },
    keyRevision: input.encrypted.keyRevision,
    componentKey: input.context.componentKey,
    encrypted: input.encrypted,
    schema: input.schema,
  });
}

async function openWorkflowRunWithContext(
  raw: WorkflowRunWire,
  context: EncryptionContext,
): Promise<WorkflowRun> {
  const wire = workflowRunWireSchema.parse(raw);
  const [input, result, error] = await Promise.all([
    openRuntimeField({
      context,
      encrypted: wire.protectedInput,
      field: "input",
      recordId: wire.id,
      recordKind: "workflow-run",
      schema: workflowRunProtectedInputSchema,
    }),
    wire.protectedResult
      ? openRuntimeField({
          context,
          encrypted: wire.protectedResult,
          field: "result",
          recordId: wire.id,
          recordKind: "workflow-run",
          schema: workflowRunProtectedResultSchema,
        })
      : null,
    wire.protectedError
      ? openRuntimeField({
          context,
          encrypted: wire.protectedError,
          field: "error",
          recordId: wire.id,
          recordKind: "workflow-run",
          schema: workflowProtectedErrorSchema,
        })
      : null,
  ]);
  return workflowRunSchema.parse({
    ...wire,
    protectedInput: undefined,
    protectedResult: undefined,
    protectedError: undefined,
    structuredInput: input.input,
    structuredResult: result?.result ?? null,
    errorCode: error?.code ?? wire.errorCode,
    errorMessage: error?.message ?? wire.errorMessage,
  });
}

export async function openWorkflowRunWire(
  raw: WorkflowRunWire,
  options: TrustedOptions = {},
): Promise<WorkflowRun> {
  const context = encryptionContext(options);
  try {
    return await openWorkflowRunWithContext(raw, context);
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

async function openWorkflowGateWithContext(
  raw: unknown,
  context: EncryptionContext,
) {
  const wire = workflowApprovalGateWireSchema.parse(raw);
  const [request, response] = await Promise.all([
    decryptWorkflowContent({
      ownerId: context.ownerId,
      context: {
        recordKind: "workflow-gate",
        recordId: wire.id,
        field: "request",
      },
      keyRevision: wire.protectedRequest.keyRevision,
      componentKey: context.componentKey,
      encrypted: wire.protectedRequest,
      schema: workflowGateProtectedRequestSchema,
    }),
    wire.protectedResponse
      ? decryptWorkflowContent({
          ownerId: context.ownerId,
          context: {
            recordKind: "workflow-gate",
            recordId: wire.id,
            field: "response",
          },
          keyRevision: wire.protectedResponse.keyRevision,
          componentKey: context.componentKey,
          encrypted: wire.protectedResponse,
          schema: workflowGateProtectedResponseSchema,
        })
      : null,
  ]);
  if (response && response.decision !== wire.decision) {
    throw new Error("Protected workflow gate decision does not match status.");
  }
  return workflowApprovalGateSchema.parse({
    ...wire,
    protectedRequest: undefined,
    protectedResponse: undefined,
    prompt: request.prompt,
    permissionManifest: request.permissionManifest,
    decisionReason: response?.reason ?? null,
  });
}

export async function protectWorkflowGateDecision(
  gateId: string,
  raw: WorkflowGateDecision,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowGateDecision> {
  const input = workflowGateDecisionSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    return encryptedWorkflowGateDecisionSchema.parse({
      classification: { decision: input.decision },
      protectedResponse: await encryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "workflow-gate",
          recordId: gateId,
          field: "response",
        },
        keyRevision: context.keyRevision,
        componentKey: context.componentKey,
        content: {
          version: 1,
          decision: input.decision,
          reason: input.reason,
        },
        schema: workflowGateProtectedResponseSchema,
      }),
      idempotencyKey: input.idempotencyKey,
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openWorkflowRunWireDetail(
  raw: WorkflowRunWireDetail,
  options: TrustedOptions = {},
): Promise<WorkflowRunDetail> {
  const wire = workflowRunWireDetailSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const run = await openWorkflowRunWithContext(wire.run, context);
    const nodes = await Promise.all(
      wire.nodes.map(async (node) => {
        const [input, result, error] = await Promise.all([
          node.protectedInput
            ? openRuntimeField({
                context,
                encrypted: node.protectedInput,
                field: "input",
                recordId: node.id,
                recordKind: "workflow-run-node",
                schema: workflowNodeProtectedInputSchema,
              })
            : null,
          node.protectedResult
            ? openRuntimeField({
                context,
                encrypted: node.protectedResult,
                field: "result",
                recordId: node.id,
                recordKind: "workflow-run-node",
                schema: workflowNodeProtectedResultSchema,
              })
            : null,
          node.protectedError
            ? openRuntimeField({
                context,
                encrypted: node.protectedError,
                field: "error",
                recordId: node.id,
                recordKind: "workflow-run-node",
                schema: workflowProtectedErrorSchema,
              })
            : null,
        ]);
        return workflowRunNodeSchema.parse({
          ...node,
          protectedInput: undefined,
          protectedResult: undefined,
          protectedError: undefined,
          structuredInput: input?.input ?? {},
          structuredResult: result?.structuredResult ?? null,
          errorCode: error?.code,
          errorMessage: error?.message,
        });
      }),
    );
    const items = wire.items.map((item) =>
      workflowRunNodeItemSchema.parse({
        ...item,
        protectedInput: undefined,
        protectedResult: undefined,
        protectedError: undefined,
        structuredInput: {},
        structuredResult: null,
      }),
    );
    const attempts = await Promise.all(
      wire.attempts.map(async (attempt) => {
        const [input, result, error] = await Promise.all([
          attempt.protectedInput
            ? openRuntimeField({
                context,
                encrypted: attempt.protectedInput,
                field: "input",
                recordId: attempt.id,
                recordKind: "workflow-attempt",
                schema: workflowNodeProtectedInputSchema,
              })
            : null,
          attempt.protectedResult
            ? openRuntimeField({
                context,
                encrypted: attempt.protectedResult,
                field: "result",
                recordId: attempt.id,
                recordKind: "workflow-attempt",
                schema: workflowNodeProtectedResultSchema,
              })
            : null,
          attempt.protectedError
            ? openRuntimeField({
                context,
                encrypted: attempt.protectedError,
                field: "error",
                recordId: attempt.id,
                recordKind: "workflow-attempt",
                schema: workflowProtectedErrorSchema,
              })
            : null,
        ]);
        return workflowNodeAttemptSchema.parse({
          ...attempt,
          protectedInput: undefined,
          protectedResult: undefined,
          protectedError: undefined,
          structuredInput: input?.input ?? {},
          structuredResult: result?.structuredResult ?? null,
          errorCode: error?.code ?? attempt.errorCode,
          errorMessage: error?.message ?? attempt.errorMessage,
        });
      }),
    );
    const gates = await Promise.all(
      wire.gates.map((gate) => openWorkflowGateWithContext(gate, context)),
    );
    return workflowRunDetailSchema.parse({
      ...wire,
      run,
      nodes,
      items,
      attempts,
      gates,
    });
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected workflow run content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}
