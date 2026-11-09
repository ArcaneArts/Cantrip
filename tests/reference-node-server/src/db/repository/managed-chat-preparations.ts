import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  managedChatPreparationSchema,
  type ManagedChatPreparation,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
const wire = (row: typeof schema.managedChatPreparations.$inferSelect) =>
  managedChatPreparationSchema.parse({
    ...row,
    updatedAt: row.updatedAt.toISOString(),
  });
export class ManagedChatPreparationRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async get(ownerId: string, chatId: string) {
    const [row] = await this.database
      .select()
      .from(schema.managedChatPreparations)
      .where(
        and(
          eq(schema.managedChatPreparations.ownerId, ownerId),
          eq(schema.managedChatPreparations.chatId, chatId),
        ),
      );
    return row ? wire(row) : null;
  }
  async request(ownerId: string, chatId: string, workerId: string) {
    await this.database
      .insert(schema.managedChatPreparations)
      .values({
        ownerId,
        chatId,
        workerId,
        terminalId: randomUUID(),
        generation: randomUUID(),
      })
      .onConflictDoUpdate({
        target: schema.managedChatPreparations.chatId,
        set: { phase: "pending", failedPhase: null, updatedAt: new Date() },
        setWhere: eq(schema.managedChatPreparations.ownerId, ownerId),
      });
    return this.get(ownerId, chatId);
  }
  async claim(ownerId: string, chatId: string, workerId: string) {
    const [row] = await this.database
      .update(schema.managedChatPreparations)
      .set({
        workerId,
        generation: randomUUID(),
        phase: "thread",
        failedPhase: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.managedChatPreparations.ownerId, ownerId),
          eq(schema.managedChatPreparations.chatId, chatId),
        ),
      )
      .returning();
    return row ? wire(row) : null;
  }
  async update(
    ownerId: string,
    state: ManagedChatPreparation,
    phase: ManagedChatPreparation["phase"],
    failedPhase: ManagedChatPreparation["failedPhase"] = null,
    terminalId = state.terminalId,
  ) {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.managedChatPreparations)
        .set({ phase, failedPhase, terminalId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.managedChatPreparations.ownerId, ownerId),
            eq(schema.managedChatPreparations.chatId, state.chatId),
            eq(schema.managedChatPreparations.generation, state.generation),
            phase === "ready"
              ? eq(schema.managedChatPreparations.phase, "console")
              : undefined,
          ),
        )
        .returning();
      if (
        row &&
        (phase === "ready" || (phase === "failed" && failedPhase === "console"))
      )
        await tx
          .update(schema.terminals)
          .set({
            status: phase === "ready" ? "running" : "failed",
            updatedAt: new Date(),
          })
          .where(eq(schema.terminals.id, terminalId));
      return row ? wire(row) : null;
    });
  }
  async consoleExited(
    ownerId: string,
    workerId: string,
    terminalId: string,
    generation: string,
  ) {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.managedChatPreparations)
        .set({ phase: "failed", failedPhase: "console", updatedAt: new Date() })
        .where(
          and(
            eq(schema.managedChatPreparations.ownerId, ownerId),
            eq(schema.managedChatPreparations.workerId, workerId),
            eq(schema.managedChatPreparations.terminalId, terminalId),
            eq(schema.managedChatPreparations.generation, generation),
            inArray(schema.managedChatPreparations.phase, ["console", "ready"]),
          ),
        )
        .returning();
      if (row)
        await tx
          .update(schema.terminals)
          .set({ status: "exited", updatedAt: new Date() })
          .where(eq(schema.terminals.id, terminalId));
      return row ? wire(row) : null;
    });
  }
  async forWorker(ownerId: string, workerId: string) {
    const rows = await this.database
      .select({ chatId: schema.managedChatPreparations.chatId })
      .from(schema.managedChatPreparations)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.managedChatPreparations.chatId),
      )
      .where(
        and(
          eq(schema.managedChatPreparations.ownerId, ownerId),
          eq(schema.managedChatPreparations.workerId, workerId),
          isNull(schema.chats.archivedAt),
        ),
      );
    return rows.map((row) => row.chatId);
  }
}
