import {
  clearSensitiveBytes,
  decryptProjectAutomationContent,
  encryptProjectAutomationContent,
} from "@cantrip/crypto";
import {
  automationRunWireSchema,
  councilAutomationWireSchema,
  encryptedProjectAutomationCreateSchema,
  encryptedProjectAutomationUpdateSchema,
  projectAutomationProtectedConditionSchema,
  projectAutomationProtectedNameSchema,
  projectAutomationProtectedPromptSchema,
  projectAutomationSchema,
  projectAutomationWireSchema,
  type EncryptedProjectAutomationCreate,
  type EncryptedProjectAutomationUpdate,
  type ProjectAutomation,
  type ProjectAutomationCreate,
  type ProjectAutomationUpdate,
  type ProjectAutomationWire,
} from "@cantrip/protocol/automations";
import type { ProjectAutomationContentOpaque } from "@cantrip/protocol/project-automation-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

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
    service,
    identity: snapshot.identity,
  };
}

async function openField<T>(input: {
  automationId: string;
  encrypted: ProjectAutomationContentOpaque;
  field: "name" | "prompt" | "condition";
  schema: { parse(value: unknown): T };
  context: ReturnType<typeof encryptionContext>;
}) {
  const { context, encrypted } = input;
  const componentKey =
    encrypted.keyRevision === context.keyRevision
      ? context.componentKey
      : context.service.componentKey({
          component: "workflow-content",
          identity: context.identity,
          keyRevision: encrypted.keyRevision,
        });
  try {
    return await decryptProjectAutomationContent({
      ownerId: context.ownerId,
      context: {
        recordKind: "project-automation",
        recordId: input.automationId,
        field: input.field,
      },
      keyRevision: encrypted.keyRevision,
      componentKey,
      encrypted,
      schema: input.schema,
    });
  } finally {
    if (componentKey !== context.componentKey)
      clearSensitiveBytes(componentKey);
  }
}

async function protectField<T>(input: {
  automationId: string;
  content: T;
  field: "name" | "prompt" | "condition";
  schema: { parse(value: unknown): T };
  context: ReturnType<typeof encryptionContext>;
}) {
  return encryptProjectAutomationContent({
    ownerId: input.context.ownerId,
    context: {
      recordKind: "project-automation",
      recordId: input.automationId,
      field: input.field,
    },
    keyRevision: input.context.keyRevision,
    componentKey: input.context.componentKey,
    content: input.content,
    schema: input.schema,
  });
}

export async function protectProjectAutomationCreate(
  input: ProjectAutomationCreate,
  options: TrustedOptions = {},
): Promise<EncryptedProjectAutomationCreate> {
  const context = encryptionContext(options);
  const id = crypto.randomUUID();
  try {
    const [protectedName, protectedPrompt, protectedCondition] =
      await Promise.all([
        protectField({
          automationId: id,
          content: { version: 1, name: input.name } as const,
          field: "name",
          schema: projectAutomationProtectedNameSchema,
          context,
        }),
        protectField({
          automationId: id,
          content: { version: 1, prompt: input.prompt } as const,
          field: "prompt",
          schema: projectAutomationProtectedPromptSchema,
          context,
        }),
        protectField({
          automationId: id,
          content: { version: 1, condition: input.condition } as const,
          field: "condition",
          schema: projectAutomationProtectedConditionSchema,
          context,
        }),
      ]);
    return encryptedProjectAutomationCreateSchema.parse({
      id,
      chatId: input.chatId,
      schedule: input.schedule,
      enabled: input.enabled,
      content: { protectedName, protectedPrompt, protectedCondition },
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function protectProjectAutomationUpdate(
  automationId: string,
  input: ProjectAutomationUpdate,
  options: TrustedOptions = {},
): Promise<EncryptedProjectAutomationUpdate> {
  const context = encryptionContext(options);
  try {
    const content: Record<string, unknown> = {};
    if (input.name !== undefined) {
      content.protectedName = await protectField({
        automationId,
        content: { version: 1, name: input.name } as const,
        field: "name",
        schema: projectAutomationProtectedNameSchema,
        context,
      });
    }
    if (input.prompt !== undefined) {
      content.protectedPrompt = await protectField({
        automationId,
        content: { version: 1, prompt: input.prompt } as const,
        field: "prompt",
        schema: projectAutomationProtectedPromptSchema,
        context,
      });
    }
    if (input.condition !== undefined) {
      content.protectedCondition = await protectField({
        automationId,
        content: { version: 1, condition: input.condition } as const,
        field: "condition",
        schema: projectAutomationProtectedConditionSchema,
        context,
      });
    }
    return encryptedProjectAutomationUpdateSchema.parse({
      ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(Object.keys(content).length === 0 ? {} : { content }),
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openProjectAutomationWire(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ProjectAutomation> {
  return projectAutomationSchema.parse(
    await openAutomationDefinition(
      projectAutomationWireSchema.parse(raw),
      options,
    ),
  );
}

export async function openCouncilAutomationWire(
  raw: unknown,
  options: TrustedOptions = {},
) {
  return openAutomationDefinition(
    councilAutomationWireSchema.parse(raw),
    options,
  );
}

async function openAutomationDefinition<
  T extends Omit<ProjectAutomationWire, "projectId"> & {
    projectId: string | null;
  },
>(automation: T, options: TrustedOptions) {
  const { content, ...metadata } = automation;
  const context = encryptionContext(options);
  try {
    const [name, prompt, condition] = await Promise.all([
      openField({
        automationId: automation.id,
        field: "name",
        encrypted: content.protectedName,
        schema: projectAutomationProtectedNameSchema,
        context,
      }),
      openField({
        automationId: automation.id,
        field: "prompt",
        encrypted: content.protectedPrompt,
        schema: projectAutomationProtectedPromptSchema,
        context,
      }),
      openField({
        automationId: automation.id,
        field: "condition",
        encrypted: content.protectedCondition,
        schema: projectAutomationProtectedConditionSchema,
        context,
      }),
    ]);
    return {
      ...metadata,
      name: name.name,
      prompt: prompt.prompt,
      condition: condition.condition,
    };
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected automation content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openAutomationRunWire(
  raw: unknown,
  options: TrustedOptions = {},
) {
  const { protectedName, protectedPrompt, ...run } =
    automationRunWireSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const [name, prompt] = await Promise.all([
      openField({
        automationId: run.automationId,
        field: "name",
        encrypted: protectedName,
        schema: projectAutomationProtectedNameSchema,
        context,
      }),
      openField({
        automationId: run.automationId,
        field: "prompt",
        encrypted: protectedPrompt,
        schema: projectAutomationProtectedPromptSchema,
        context,
      }),
    ]);
    return { ...run, name: name.name, prompt: prompt.prompt };
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}
