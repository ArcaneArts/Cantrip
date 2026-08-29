import { z } from "zod";
import {
  cantripCliArgumentsSchema,
  cantripAgentOperationResultSchema,
} from "./cantrip-mcp.js";

export const cantripCliCommandResultSchema = cantripAgentOperationResultSchema;

export const cantripCliCommandNameSchema = z.enum([
  "status",
  "policy.list",
  "policy.read",
  "worktree.list",
  "worktree.create",
  "worktree.switch",
  "worktree.status",
  "worktree.release",
  "worktree.remove",
  "target.list",
  "target.show",
  "run.list",
  "run.show",
  "run.detect",
  "run.create",
  "run.update",
  "run.delete",
  "run.start",
  "run.restart",
  "run.status",
  "run.logs",
  "run.stop",
  "run.secret-set",
  "target.resolve-browser",
  "target.resolve-explorer",
  "target.resolve-terminal",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "browser.services",
  "browser.create",
  "browser.open",
]);

export const cantripCliContextSchema = z
  .object({
    codexThreadId: z.string().min(1).max(200).nullable().default(null),
    terminalId: z.string().min(1).max(200).nullable().default(null),
    cwd: z.string().min(1).max(8_192).nullable().default(null),
    selection: z.enum(["auto", "cwd", "lane"]).default("auto"),
  })
  .strict();

export const cantripCliCommandRequestSchema = z
  .object({
    command: cantripCliCommandNameSchema,
    context: cantripCliContextSchema,
    arguments: cantripCliArgumentsSchema,
  })
  .strict();

export const workerCliCommandCallSchema = cantripCliCommandRequestSchema
  .extend({
    chatContext: z
      .object({
        chatId: z.string().min(1).max(200),
        executionLaneId: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
    requestId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
  })
  .strict();

export type CantripCliCommandName = z.infer<typeof cantripCliCommandNameSchema>;
export type CantripCliContext = z.infer<typeof cantripCliContextSchema>;
export type CantripCliCommandRequest = z.infer<
  typeof cantripCliCommandRequestSchema
>;
export type WorkerCliCommandCall = z.infer<typeof workerCliCommandCallSchema>;
export type CantripCliCommandResult = z.infer<
  typeof cantripCliCommandResultSchema
>;
