import {
  clearSensitiveBytes,
  decryptWorkflowContent,
  encryptWorkflowContent,
} from "@cantrip/crypto";
import {
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
} from "@cantrip/protocol/automations";

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
  };
}

async function protectField<T>(input: {
  automationId: string;
  content: T;
  field: "name" | "prompt" | "condition";
  schema: { parse(value: unknown): T };
  context: ReturnType<typeof encryptionContext>;
}) {
  return encryptWorkflowContent({
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
  const automation = projectAutomationWireSchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const [name, prompt, condition] = await Promise.all([
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "project-automation",
          recordId: automation.id,
          field: "name",
        },
        keyRevision: automation.content.protectedName.keyRevision,
        componentKey: context.componentKey,
        encrypted: automation.content.protectedName,
        schema: projectAutomationProtectedNameSchema,
      }),
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "project-automation",
          recordId: automation.id,
          field: "prompt",
        },
        keyRevision: automation.content.protectedPrompt.keyRevision,
        componentKey: context.componentKey,
        encrypted: automation.content.protectedPrompt,
        schema: projectAutomationProtectedPromptSchema,
      }),
      decryptWorkflowContent({
        ownerId: context.ownerId,
        context: {
          recordKind: "project-automation",
          recordId: automation.id,
          field: "condition",
        },
        keyRevision: automation.content.protectedCondition.keyRevision,
        componentKey: context.componentKey,
        encrypted: automation.content.protectedCondition,
        schema: projectAutomationProtectedConditionSchema,
      }),
    ]);
    return projectAutomationSchema.parse({
      ...automation,
      content: undefined,
      name: name.name,
      prompt: prompt.prompt,
      condition: condition.condition,
    });
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected automation content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}
