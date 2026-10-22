import { z } from "zod";
import { protectedTunnelContentRecordSchema } from "./tunnel-content.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { executionTargetSchema } from "./execution-targets.js";
import { tunnelResourceIdSchema } from "./tunnels.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

export const codeAppearanceSchema = z.enum([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
  "pro-light",
  "pro-dark",
  "pro-high-contrast-light",
  "pro-high-contrast-dark",
]);

const codeTabCreateBaseSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    ...projectPaneDestinationShape,
    target: executionTargetSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.worktreeId && input.target) {
      context.addIssue({
        code: "custom",
        message: "Choose either a legacy worktreeId or an execution target.",
      });
    }
    if (!hasUnambiguousProjectPaneDestination(input)) {
      context.addIssue({
        code: "custom",
        message:
          "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
        path: ["paneId"],
      });
    }
  });

export const codeTabCreateSchema = codeTabCreateBaseSchema.safeExtend({
  title: z.string().trim().min(1).max(200).default("Code"),
});

export const encryptedCodeTabCreateSchema = codeTabCreateBaseSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .refine(
    (input) => input.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((input) => input.title !== undefined, {
    message: "At least one Code tab field is required.",
  });

export const encryptedCodeTabUpdateSchema = z
  .object({
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection === undefined) {
      context.addIssue({
        code: "custom",
        message: "At least one Code tab field is required.",
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "code-tab"
    ) {
      context.addIssue({
        code: "custom",
        message: "Code-tab title classification must be code-tab.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const codeTabSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeTabSummarySchema = codeTabSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
});

export const codeTabWireSummarySchema = codeTabSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .refine(
    (codeTab) =>
      codeTab.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabListSchema = z.array(codeTabSummarySchema);
export const codeTabWireListSchema = z.array(codeTabWireSummarySchema);

export const projectShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const PROJECT_SHARE_STATE_STALE_CODE = "project-share-state-stale";

export const projectShareTunnelCreateSchema = z
  .object({
    tunnelId: z.string().uuid(),
    workerId: tunnelResourceIdSchema,
    worktreeId: z.string().min(1).optional(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ tunnelId, protectedRecord }) =>
      tunnelId === protectedRecord.operationId || protectedRecord.revision > 1,
    {
      message:
        "A new project share must bind its tunnel identity to its protected record.",
      path: ["protectedRecord", "operationId"],
    },
  );

export const projectShareDirectCreateSchema = z
  .object({
    clientId: tunnelResourceIdSchema,
  })
  .strict();

export const projectShareAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    projectId: tunnelResourceIdSchema,
    protocol: z.literal("webdav"),
    tunnelId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    mountLeaseMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export const standaloneChatShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  chatId: z.string().uuid(),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const standaloneChatShareAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    chatId: z.string().uuid(),
    protocol: z.literal("webdav"),
    tunnelId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    mountLeaseMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export const projectSharePublicBasePathSchema = z
  .string()
  .regex(/^\/project-shares\/[A-Za-z0-9_-]{43}$/u);

export const projectSharePublicOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
});

export type CodeAppearance = z.infer<typeof codeAppearanceSchema>;
export type CodeTabCreate = z.infer<typeof codeTabCreateSchema>;
export type EncryptedCodeTabCreate = z.infer<
  typeof encryptedCodeTabCreateSchema
>;
export type CodeTabUpdate = z.infer<typeof codeTabUpdateSchema>;
export type EncryptedCodeTabUpdate = z.infer<
  typeof encryptedCodeTabUpdateSchema
>;
export type CodeTabSummary = z.infer<typeof codeTabSummarySchema>;
export type CodeTabWireSummary = z.infer<typeof codeTabWireSummarySchema>;
export type ProjectShareAttachment = z.infer<
  typeof projectShareAttachmentSchema
>;
export type ProjectShareAttachmentWire = z.infer<
  typeof projectShareAttachmentWireSchema
>;
export type StandaloneChatShareAttachment = z.infer<
  typeof standaloneChatShareAttachmentSchema
>;
export type StandaloneChatShareAttachmentWire = z.infer<
  typeof standaloneChatShareAttachmentWireSchema
>;
