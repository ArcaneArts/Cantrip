import {
  clearSensitiveBytes,
  decryptWorkflowContent,
  encryptWorkflowContent,
} from "@cantrip/crypto";
import {
  encryptedWorkflowAutomationTriggerCreateSchema,
  encryptedWorkflowAutomationTriggerUpdateSchema,
  encryptedWorkflowGitEventDeliveryCreateSchema,
  encryptedWorkflowTriggerDeliveryCreateSchema,
  workflowAutomationTriggerSchema,
  workflowAutomationTriggerWireSchema,
  workflowGitEventDeliveryCreateSchema,
  workflowTriggerDeliveryResultSchema,
  workflowTriggerDeliveryWireResultSchema,
  workflowTriggerProtectedConfigurationSchema,
  workflowTriggerProtectedDeliverySchema,
  workflowTriggerProtectedInputSchema,
  workflowTriggerProtectedNameSchema,
  type EncryptedWorkflowAutomationTriggerCreate,
  type EncryptedWorkflowAutomationTriggerUpdate,
  type EncryptedWorkflowGitEventDeliveryCreate,
  type EncryptedWorkflowTriggerDeliveryCreate,
  type WorkflowAutomationTrigger,
  type WorkflowAutomationTriggerCreate,
  type WorkflowAutomationTriggerUpdate,
  type WorkflowGitEventDeliveryCreate,
  type WorkflowTriggerDeliveryCreate,
  type WorkflowTriggerDeliveryResult,
} from "@cantrip/protocol/workflows";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import { openWorkflowRunWireDetail } from "./workflow-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

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
      component: "workflow-content",
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
  };
}

function triggerConfiguration(input: WorkflowAutomationTriggerCreate) {
  if (input.type !== "webhook") {
    return {
      version: 1 as const,
      type: input.type,
      configuration: input.configuration,
    };
  }
  return {
    version: 1 as const,
    type: input.type,
    configuration: {
      minimumIntervalSeconds: input.configuration.minimumIntervalSeconds,
      credentialConfigured: true as const,
    },
  };
}

function publicConfiguration(input: WorkflowAutomationTriggerCreate) {
  switch (input.type) {
    case "schedule":
      return { type: input.type, ...input.configuration } as const;
    case "api":
    case "webhook":
    case "saved-command":
      return {
        type: input.type,
        minimumIntervalSeconds: input.configuration.minimumIntervalSeconds,
      } as const;
    case "git":
      return {
        type: input.type,
        event: input.configuration.event,
        minimumIntervalSeconds: input.configuration.minimumIntervalSeconds,
      } as const;
  }
}

async function protectTriggerField<T>(input: {
  triggerId: string;
  content: T;
  field: "name" | "content" | "input";
  schema: { parse(value: unknown): T };
  context: ReturnType<typeof encryptionContext>;
}) {
  return encryptWorkflowContent({
    ownerId: input.context.ownerId,
    context: {
      recordKind: "workflow-trigger",
      recordId: input.triggerId,
      field: input.field,
    },
    keyRevision: input.context.keyRevision,
    componentKey: input.context.componentKey,
    content: input.content,
    schema: input.schema,
  });
}

export async function protectWorkflowAutomationTriggerCreate(
  input: WorkflowAutomationTriggerCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowAutomationTriggerCreate> {
  const context = encryptionContext(options);
  const id = crypto.randomUUID();
  const credentialHash =
    input.type === "webhook" ? input.configuration.credentialHash : null;
  const { configuration, name, structuredInput, ...metadata } = input;
  try {
    const [protectedName, protectedConfiguration, protectedInput] =
      await Promise.all([
        protectTriggerField({
          triggerId: id,
          content: { version: 1, name } as const,
          field: "name",
          schema: workflowTriggerProtectedNameSchema,
          context,
        }),
        protectTriggerField({
          triggerId: id,
          content: triggerConfiguration(input),
          field: "content",
          schema: workflowTriggerProtectedConfigurationSchema,
          context,
        }),
        protectTriggerField({
          triggerId: id,
          content: { version: 1, input: structuredInput } as const,
          field: "input",
          schema: workflowTriggerProtectedInputSchema,
          context,
        }),
      ]);
    return encryptedWorkflowAutomationTriggerCreateSchema.parse({
      ...metadata,
      id,
      permissionManifest: {
        ...input.permissionManifest,
        skills: [],
        mcpServers: [],
      },
      publicConfiguration: publicConfiguration(input),
      credentialHash,
      protectedName,
      protectedConfiguration,
      protectedInput,
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectWorkflowAutomationTriggerUpdate(
  triggerId: string,
  input: WorkflowAutomationTriggerUpdate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowAutomationTriggerUpdate> {
  const context = encryptionContext(options);
  try {
    return encryptedWorkflowAutomationTriggerUpdateSchema.parse({
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.name === undefined
        ? {}
        : {
            protectedName: await protectTriggerField({
              triggerId,
              content: { version: 1, name: input.name } as const,
              field: "name",
              schema: workflowTriggerProtectedNameSchema,
              context,
            }),
          }),
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

function publicConfigurationMatches(
  trigger: ReturnType<typeof workflowAutomationTriggerWireSchema.parse>,
  configuration: ReturnType<
    typeof workflowTriggerProtectedConfigurationSchema.parse
  >,
) {
  if (
    trigger.type !== configuration.type ||
    trigger.publicConfiguration.type !== configuration.type
  ) {
    return false;
  }
  const publicValue = trigger.publicConfiguration;
  switch (configuration.type) {
    case "schedule": {
      const privateValue = configuration.configuration;
      return (
        publicValue.type === "schedule" &&
        publicValue.intervalSeconds === privateValue.intervalSeconds &&
        publicValue.startAt === privateValue.startAt &&
        publicValue.catchUpPolicy === privateValue.catchUpPolicy &&
        publicValue.offlinePolicy === privateValue.offlinePolicy
      );
    }
    case "api":
    case "webhook":
    case "saved-command": {
      const privateValue = configuration.configuration;
      return (
        publicValue.type === configuration.type &&
        publicValue.minimumIntervalSeconds ===
          privateValue.minimumIntervalSeconds
      );
    }
    case "git": {
      const privateValue = configuration.configuration;
      return (
        publicValue.type === "git" &&
        publicValue.event === privateValue.event &&
        publicValue.minimumIntervalSeconds ===
          privateValue.minimumIntervalSeconds
      );
    }
  }
}

export async function openWorkflowAutomationTriggerWire(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<WorkflowAutomationTrigger> {
  const trigger = workflowAutomationTriggerWireSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const [name, configuration, structuredInput] = await Promise.all([
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "workflow-trigger",
          recordId: trigger.id,
          field: "name",
        },
        keyRevision: trigger.protectedName.keyRevision,
        componentKey: context.componentKey,
        encrypted: trigger.protectedName,
        schema: workflowTriggerProtectedNameSchema,
      }),
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "workflow-trigger",
          recordId: trigger.id,
          field: "content",
        },
        keyRevision: trigger.protectedConfiguration.keyRevision,
        componentKey: context.componentKey,
        encrypted: trigger.protectedConfiguration,
        schema: workflowTriggerProtectedConfigurationSchema,
      }),
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "workflow-trigger",
          recordId: trigger.id,
          field: "input",
        },
        keyRevision: trigger.protectedInput.keyRevision,
        componentKey: context.componentKey,
        encrypted: trigger.protectedInput,
        schema: workflowTriggerProtectedInputSchema,
      }),
    ]);
    if (!publicConfigurationMatches(trigger, configuration)) {
      throw new Error("The protected trigger routing manifest is invalid.");
    }
    return workflowAutomationTriggerSchema.parse({
      ...trigger,
      publicConfiguration: undefined,
      protectedName: undefined,
      protectedConfiguration: undefined,
      protectedInput: undefined,
      name: name.name,
      configuration: configuration.configuration,
      structuredInput: structuredInput.input,
      lastError: trigger.lastErrorCode
        ? `Automation delivery failed (${trigger.lastErrorCode}).`
        : null,
      lastErrorCode: undefined,
    });
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected workflow trigger content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

function deliveryRecordId(triggerId: string, operationId: string) {
  return `${triggerId}:${operationId}`;
}

async function protectDelivery(
  triggerId: string,
  operationId: string,
  content: ReturnType<typeof workflowTriggerProtectedDeliverySchema.parse>,
  options: TrustedOptions,
) {
  const context = encryptionContext(options);
  try {
    return await encryptWorkflowContent({
      ownerId: context.ownerId,
      context: {
        recordKind: "workflow-delivery",
        recordId: deliveryRecordId(triggerId, operationId),
        field: "payload",
      },
      keyRevision: context.keyRevision,
      componentKey: context.componentKey,
      content,
      schema: workflowTriggerProtectedDeliverySchema,
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectWorkflowTriggerDelivery(
  triggerId: string,
  type: "api" | "saved-command",
  input: WorkflowTriggerDeliveryCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowTriggerDeliveryCreate> {
  return encryptedWorkflowTriggerDeliveryCreateSchema.parse({
    idempotencyKey: input.idempotencyKey,
    protectedPayload: await protectDelivery(
      triggerId,
      input.idempotencyKey,
      { version: 1, type, input: input.structuredInput },
      options,
    ),
  });
}

export async function protectWorkflowGitEventDelivery(
  triggerId: string,
  input: WorkflowGitEventDeliveryCreate,
  options: TrustedOptions = {},
): Promise<EncryptedWorkflowGitEventDeliveryCreate> {
  const trusted = workflowGitEventDeliveryCreateSchema.parse(input);
  return encryptedWorkflowGitEventDeliveryCreateSchema.parse({
    event: trusted.event,
    deliveryId: trusted.deliveryId,
    protectedPayload: await protectDelivery(
      triggerId,
      trusted.deliveryId,
      {
        version: 1,
        type: "git",
        event: trusted.event,
        branch: trusted.branch,
        input: trusted.structuredInput,
      },
      options,
    ),
  });
}

export async function openWorkflowTriggerDeliveryResult(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<WorkflowTriggerDeliveryResult> {
  const wire = workflowTriggerDeliveryWireResultSchema.parse(raw);
  return workflowTriggerDeliveryResultSchema.parse({
    delivery: {
      ...wire.delivery,
      protectedPayload: undefined,
      errorMessage: wire.delivery.errorCode
        ? `Automation delivery failed (${wire.delivery.errorCode}).`
        : null,
    },
    run: await openWorkflowRunWireDetail(wire.run, options),
    replayed: wire.replayed,
  });
}
