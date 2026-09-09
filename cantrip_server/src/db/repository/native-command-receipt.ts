import {
  nativeCommandReceiptSchema,
  type NativeCommandReceipt,
  type NativeCommandSession,
} from "@cantrip/protocol";
import type * as schema from "../schema.js";
type CommandRow = typeof schema.nativeCommands.$inferSelect;

export function nativeCommandReceipt(row: CommandRow): NativeCommandReceipt {
  return nativeCommandReceiptSchema.parse({
    chatId: row.chatId,
    startsExecution: row.kind === "start",
    operationId: row.operationId,
    operationGeneration: row.operationGeneration,
    logicalOperationId: row.logicalOperationId,
    previousOperationId: row.previousOperationId,
    activationGeneration: row.activationGeneration,
    executionLaneId: row.executionLaneId,
    status: row.status,
    ...(row.settingsApplication
      ? { settingsApplication: row.settingsApplication }
      : {}),
    method: row.method,
    payloadDigest: row.payloadDigest,
    rejectionCode: row.rejectionCode,
    threadId: (row.identity as NativeCommandSession).threadId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
