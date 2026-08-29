import type { DesktopUpdateActiveWorkSummary } from "@cantrip/protocol";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";

export class DesktopUpdateStateRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async desktopUpdateActiveWork(
    ownerId: string,
  ): Promise<DesktopUpdateActiveWorkSummary> {
    const count = sql<number>`count(*)::int`;
    const [
      activeChats,
      queuedPrompts,
      terminalServices,
      workflowRuns,
      projectReplicaJobs,
      chatRelocationJobs,
      chatImportJobs,
      projectAutomationRuns,
      gitOperations,
      runConfigurationRuntimes,
    ] = await Promise.all([
      this.database
        .select({ count })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(
          and(
            isNull(schema.chats.archivedAt),
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.queuedPrompts)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.queuedPrompts.chatId),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.terminals)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.terminals.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.terminals.serviceEnabled, true)),
      this.database
        .select({ count })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
              "cancelling",
              "recovering",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectReplicaJobs)
        .where(
          and(
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            inArray(schema.projectReplicaJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatRelocationJobs)
        .where(
          and(
            eq(schema.chatRelocationJobs.ownerId, ownerId),
            inArray(schema.chatRelocationJobs.state, [
              "queued",
              "waiting-for-idle",
              "validating",
              "preparing-replica",
              "transferring-attachments",
              "hydrating-runtime",
              "ready-to-commit",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.ownerId, ownerId),
            inArray(schema.chatImportJobs.state, [
              "queued",
              "reading",
              "importing",
              "awaiting-hydration",
              "hydrating",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectAutomationRuns)
        .where(
          and(
            eq(schema.projectAutomationRuns.ownerId, ownerId),
            inArray(schema.projectAutomationRuns.status, [
              "dispatching",
              "started",
              "queued",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.gitOperations)
        .where(
          and(
            eq(schema.gitOperations.ownerId, ownerId),
            inArray(schema.gitOperations.state, [
              "queued",
              "running",
              "conflicted",
              "awaiting-user-action",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            inArray(schema.runConfigurationRuntimes.state, [
              "starting",
              "running",
              "stopping",
            ]),
          ),
        ),
    ]);

    const maximum = 4_294_967_295;
    const value = (rows: Array<{ count: number }>) =>
      Math.min(maximum, rows[0]?.count ?? 0);
    const backgroundJobs =
      value(workflowRuns) +
      value(projectReplicaJobs) +
      value(chatRelocationJobs) +
      value(chatImportJobs) +
      value(projectAutomationRuns) +
      value(gitOperations) +
      value(runConfigurationRuntimes);
    return {
      activeChats: value(activeChats),
      queuedPrompts: value(queuedPrompts),
      terminalServices: value(terminalServices),
      backgroundJobs: Math.min(maximum, backgroundJobs),
    };
  }
}
