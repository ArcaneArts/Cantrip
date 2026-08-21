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
  encryptedWorkflowRevisionCreateSchema,
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
  workflowRevisionProtectedProvenanceSchema,
  workflowRevisionSchema,
  workflowRevisionSummarySchema,
  workflowRevisionWireSchema,
  workflowRevisionWireSummarySchema,
  type EncryptedWorkflowDefinitionCreate,
  type EncryptedWorkflowDefinitionUpdate,
  type EncryptedWorkflowRevisionCreate,
  type WorkflowDefinitionCreate,
  type WorkflowDefinitionDetail,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionUpdate,
  type WorkflowDefinitionWireDetail,
  type WorkflowDefinitionWireSummary,
  type WorkflowRevision,
  type WorkflowRevisionCreate,
  type WorkflowRevisionSummary,
  type WorkflowRevisionWire,
  type WorkflowRevisionWireSummary,
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
  field: "slug" | "name" | "description" | "provenance" | "content-hash";
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
  field: "slug" | "name" | "description" | "provenance" | "content-hash";
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
  const [protectedProvenance, protectedContentHash] = await Promise.all([
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
  ]);
  const { provenance: _provenance, ...publicInput } = input;
  return encryptedWorkflowRevisionCreateSchema.parse({
    ...publicInput,
    id,
    contentBlindIndex: blindIndex({
      canonicalValue: contentHash,
      context,
      field: "content-hash",
      recordKind: "workflow-revision",
    }),
    content: { protectedProvenance, protectedContentHash },
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
    content: raw.content,
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
  const summary = await openRevisionSummaryWithContext(revision, context);
  return workflowRevisionSchema.parse({
    ...revision,
    ...summary,
    content: undefined,
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
