import { sql } from "drizzle-orm";
import {
  projectAlertSchema,
  projectAlertProjectionSchema,
  projectAlertQuerySchema,
  projectAlertPageSchema,
  projectAlertCountsSchema,
  projectAlertChangeSchema,
  agentAlertMutationWireSchema,
  projectGoalObservationSchema,
  projectGoalObservationResultSchema,
  type ProjectGoalObservation,
  type AgentAlertMutationWire,
  type ProjectAlertProjection,
  type ProjectAlertQuery,
  type ProjectAlertChange,
} from "@cantrip/protocol";
import type { ChatExecutionContext } from "./chat-execution-lanes.js";
import type { RepositoryDatabase } from "./database.js";

export const PROJECT_ALERT_CHANNEL = "cantrip_project_alerts";

/** A projection of source attention; this repository never executes source actions. */
export class ProjectAlertRepository {
  private readonly observers = new Set<(change: ProjectAlertChange) => void>();
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly expireInteractions: () => Promise<unknown>,
  ) {}

  private async value(query: ReturnType<typeof sql>) {
    const result = await this.database.execute(query);
    // Drizzle's postgres-js driver returns rows directly; PGlite wraps them.
    const rows = (
      Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
    ) as { value: unknown }[];
    return rows[0]?.value ?? null;
  }
  async apply(ownerId: string, input: ProjectAlertProjection) {
    const event = projectAlertProjectionSchema.parse(input);
    const value = await this.value(
      sql`SELECT project_alert_apply(${ownerId},${JSON.stringify(event)}::jsonb) AS value`,
    );
    return value === null ? null : projectAlertSchema.parse(value);
  }
  async registerGoalWorker(
    ownerId: string,
    workerId: string,
    generation: string,
  ) {
    await this.database.execute(
      sql`UPDATE workers SET project_goal_generation=${generation} WHERE id=${workerId} AND owner_id=${ownerId}`,
    );
  }
  async goalChats(
    ownerId: string,
    workerId: string,
    after: string | null = null,
  ) {
    const chats = await this.value(
      sql`SELECT project_alert_goal_chats(${ownerId},${workerId},${after}) AS value`,
    );
    if (
      !Array.isArray(chats) ||
      chats.length > 100 ||
      chats.some((chat) => typeof chat !== "string" || !chat)
    )
      throw new Error("Invalid Goal source page.");
    return chats as string[];
  }
  async observeGoal(ownerId: string, input: ProjectGoalObservation) {
    const event = projectGoalObservationSchema.parse(input);
    return projectGoalObservationResultSchema.parse(
      await this.value(
        sql`SELECT project_alert_observe_goal(${ownerId},${event.workerId},${JSON.stringify(event)}::jsonb) AS value`,
      ),
    );
  }
  async applyAgent(
    ownerId: string,
    context: ChatExecutionContext,
    input: AgentAlertMutationWire,
  ) {
    const mutation = agentAlertMutationWireSchema.parse(input);
    const event = projectAlertProjectionSchema.parse({
      projectId: context.projectId,
      chatId: context.chatId,
      source: "agent",
      sourceId: context.chatId,
      episodeId: mutation.key,
      sourceRevision: mutation.revision,
      status: mutation.status,
      kind: mutation.kind,
      target: { kind: "chat", chatId: context.chatId, turnId: null },
      protectedDetail: mutation.protectedDetail,
      occurredAt: new Date().toISOString(),
    });
    const value = await this.value(
      sql`SELECT project_alert_agent_apply(${ownerId},${context.chatId},${context.workerId},${context.executionLaneId},${JSON.stringify(event)}::jsonb) AS value`,
    );
    return value === null ? null : projectAlertSchema.parse(value);
  }
  async list(
    ownerId: string,
    projectId: string,
    input: Partial<ProjectAlertQuery> = {},
  ) {
    const query = projectAlertQuerySchema.parse(input);
    await this.expireInteractions();
    const value = await this.value(
      sql`SELECT project_alert_page(${ownerId},${projectId},${query.limit},${query.after ?? null}) AS value`,
    );
    return value === null ? null : projectAlertPageSchema.parse(value);
  }
  async counts(ownerId: string) {
    await this.expireInteractions();
    return projectAlertCountsSchema.parse(
      await this.value(sql`SELECT project_alert_counts(${ownerId}) AS value`),
    );
  }
  subscribe(observer: (change: ProjectAlertChange) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  receive(payload: string): void {
    if (payload.length > 4096) return;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = projectAlertChangeSchema.safeParse(value);
    if (!parsed.success) return;
    for (const observer of this.observers) observer(parsed.data);
  }
}
