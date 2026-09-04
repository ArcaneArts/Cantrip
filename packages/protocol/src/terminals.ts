import { z } from "zod";
import {
  surfaceStreamOpaqueSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import { repositoryOperationOpaqueSchema } from "./repository-operation.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { terminalPrivateStateOpaqueSchema } from "./surface-private-state.js";
import { executionTargetSchema } from "./execution-targets.js";
import { repositoryRelativePathSchema } from "./repository-paths.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

const terminalPlacementSchema = z
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
          "Specify either paneId or the deprecated tabGroupId, not both.",
        path: ["paneId"],
      });
    }
  });

export const terminalCreateSchema = terminalPlacementSchema.safeExtend({
  directoryPath: repositoryRelativePathSchema.optional(),
  title: z.string().trim().min(1).max(200).default("Terminal"),
});

export const encryptedTerminalCreateSchema = terminalPlacementSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const encryptedLinkedConsoleCreateSchema = z
  .object({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Linked console title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const terminalUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedTerminalUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "terminal",
    {
      message: "Terminal title classification must be terminal.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const terminalServiceConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    command: z.string().max(100_000),
  })
  .superRefine((configuration, context) => {
    if (configuration.enabled && configuration.command.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "A command is required when terminal service mode is enabled.",
        path: ["command"],
      });
    }
  });

export const encryptedTerminalServiceConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict();

export const terminalServiceRuntimeConfigurationSchema = z
  .object({
    terminalId: z.string().min(1),
    serverId: z.string().min(1).max(255),
    worktreePath: z.string().min(1).max(8_192),
    stateProtection: terminalPrivateStateOpaqueSchema,
  })
  .strict();

export const terminalKindSchema = z.enum([
  "interactive",
  "chat-console",
  "run-configuration",
]);

const terminalSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: terminalKindSchema,
  position: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "exited", "offline", "failed"]),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  linkedChatId: z.string().min(1).nullable(),
  runConfigurationId: z.string().uuid().nullable(),
  runConfigurationRuntimeId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const terminalSummarySchema = terminalSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  directoryPath: repositoryRelativePathSchema.nullable(),
  service: terminalServiceConfigurationSchema,
});

export const terminalWireSummarySchema = terminalSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    stateProtection: terminalPrivateStateOpaqueSchema.nullable(),
    serviceEnabled: z.boolean(),
  })
  .strict()
  .superRefine((terminal, context) => {
    if (terminal.kind === "run-configuration") {
      if (
        terminal.titleProtection !== null ||
        terminal.stateProtection !== null ||
        terminal.linkedChatId !== null ||
        terminal.runConfigurationId === null ||
        terminal.runConfigurationRuntimeId === null ||
        terminal.serviceEnabled
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Run configuration terminals require only their runtime binding.",
        });
      }
      return;
    }
    if (
      terminal.titleProtection === null ||
      terminal.stateProtection === null ||
      terminal.runConfigurationId !== null ||
      terminal.runConfigurationRuntimeId !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Interactive terminals require protected label and state fields.",
      });
      return;
    }
    if (terminal.titleProtection.classification.recordKind !== "terminal") {
      context.addIssue({
        code: "custom",
        message: "Terminal title classification must be terminal.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    if (
      (terminal.kind === "chat-console") !==
      (terminal.linkedChatId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only chat console terminals may have a linked chat.",
        path: ["linkedChatId"],
      });
    }
  });

export const terminalListSchema = z.array(terminalSummarySchema);
export const terminalWireListSchema = z.array(terminalWireSummarySchema);

export const scriptCommandKindSchema = z.enum([
  "package",
  "dart",
  "just",
  "cargo",
  "gradle",
  "make",
]);

const scriptCommandTextSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Script command text cannot contain control characters.",
  });

export const scriptCommandSchema = z.object({
  id: z.string().min(1).max(512),
  kind: scriptCommandKindSchema,
  name: scriptCommandTextSchema.max(200),
  command: scriptCommandTextSchema.max(4_096),
  description: scriptCommandTextSchema.max(4_096).nullable(),
  source: scriptCommandTextSchema.max(512),
});

export const scriptCommandListSchema = z.array(scriptCommandSchema).max(500);

export const protectedScriptCommandListSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    protectedCommands: repositoryOperationOpaqueSchema,
  })
  .strict();

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    operationId: surfaceStreamWireRequestSchema.shape.operationId,
    sequence: surfaceStreamWireRequestSchema.shape.sequence,
    protectedData: surfaceStreamOpaqueSchema,
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
]);

const terminalHydrationDimensionsSchema = z.object({
  cols: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000),
  outputBoundary: z.number().int().nonnegative().safe().optional(),
  processGeneration: z.number().int().positive().safe().optional(),
});

export const terminalHydrationMetadataSchema = z.discriminatedUnion("format", [
  terminalHydrationDimensionsSchema.extend({
    format: z.literal("canonical-xterm"),
    version: z.literal(1),
    generation: z.number().int().nonnegative().safe(),
    activeBuffer: z.enum(["normal", "alternate"]),
    cursor: z.object({
      x: z.number().int().nonnegative().safe(),
      y: z.number().int().nonnegative().safe(),
    }),
    modes: z.object({
      applicationCursorKeysMode: z.boolean(),
      applicationKeypadMode: z.boolean(),
      bracketedPasteMode: z.boolean(),
      insertMode: z.boolean(),
      mouseTrackingMode: z.enum(["none", "x10", "vt200", "drag", "any"]),
      originMode: z.boolean(),
      reverseWraparoundMode: z.boolean(),
      sendFocusMode: z.boolean(),
      synchronizedOutputMode: z.boolean(),
      wraparoundMode: z.boolean(),
    }),
    scrollbackRows: z.number().int().nonnegative().safe(),
    snapshotCharacters: z.number().int().nonnegative().safe(),
    snapshotChunks: z.number().int().positive().safe(),
  }),
  terminalHydrationDimensionsSchema.extend({
    format: z.literal("legacy-raw"),
    version: z.literal(1),
    generation: z.number().int().nonnegative().safe(),
    truncated: z.boolean(),
    recovery: z
      .enum(["not-needed", "redraw-requested", "redraw-failed"])
      .optional(),
    recoveryReason: z.enum(["no-live-process", "resize-failed"]).optional(),
    snapshotCharacters: z.number().int().nonnegative().safe(),
    snapshotChunks: z.number().int().positive().safe(),
  }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("output"),
    operationId: surfaceStreamWireRequestSchema.shape.operationId,
    sequence: surfaceStreamWireRequestSchema.shape.sequence,
    protectedData: surfaceStreamOpaqueSchema,
    hydration: terminalHydrationMetadataSchema.optional(),
  }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string().min(1) }),
]);

export const terminalOpenResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("detached") }),
  z.object({
    status: z.literal("exited"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
]);

export const terminalSnapshotResultSchema = z.object({
  terminalId: z.string().min(1).max(200),
  status: z.enum(["running", "restarting", "exited", "not-running"]),
  data: z.string().max(100_000),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
});

export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
export type EncryptedTerminalCreate = z.infer<
  typeof encryptedTerminalCreateSchema
>;
export type TerminalUpdate = z.infer<typeof terminalUpdateSchema>;
export type EncryptedTerminalUpdate = z.infer<
  typeof encryptedTerminalUpdateSchema
>;
export type TerminalServiceConfiguration = z.infer<
  typeof terminalServiceConfigurationSchema
>;
export type EncryptedTerminalServiceConfiguration = z.infer<
  typeof encryptedTerminalServiceConfigurationSchema
>;
export type TerminalServiceRuntimeConfiguration = z.infer<
  typeof terminalServiceRuntimeConfigurationSchema
>;
export type TerminalSummary = z.infer<typeof terminalSummarySchema>;
export type TerminalWireSummary = z.infer<typeof terminalWireSummarySchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ScriptCommandKind = z.infer<typeof scriptCommandKindSchema>;
export type ScriptCommand = z.infer<typeof scriptCommandSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type TerminalHydrationMetadata = z.infer<
  typeof terminalHydrationMetadataSchema
>;
export type TerminalOpenResult = z.infer<typeof terminalOpenResultSchema>;
export type TerminalSnapshotResult = z.infer<
  typeof terminalSnapshotResultSchema
>;
