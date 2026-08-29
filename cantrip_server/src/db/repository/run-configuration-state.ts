import { createHash, randomUUID } from "node:crypto";

import type {
  RunConfigurationRuntime,
  RunConfigurationRuntimeFailure,
  RunConfigurationRuntimeObservationApplyResult,
  RunConfigurationRuntimeOperation,
  RunConfigurationRuntimeOperationRecord,
  RunConfigurationRuntimeOperationResult,
  RunConfigurationRuntimeWorkerIdentity,
  RunConfigurationRuntimeWorkerObservation,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  runConfigurationProtectedSecretListSchema,
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
  runConfigurationSecretSummaryListSchema,
  type RunConfigurationProtectedSecret,
  type RunConfigurationSecretSetResult,
  type RunConfigurationSecretSummary,
} from "@cantrip/protocol/run-configuration-secrets";
import type { ProtectedSecretEnvelope } from "@cantrip/protocol/protected-secrets";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { attachProjectTab } from "../tab-layouts.js";
import { toISOString, type RepositoryDatabase } from "./database.js";

type RunConfigurationRuntimeRow =
  typeof schema.runConfigurationRuntimes.$inferSelect;
type RunConfigurationRuntimeOperationRow =
  typeof schema.runConfigurationRuntimeOperations.$inferSelect;
type RunConfigurationSecretRow =
  typeof schema.runConfigurationSecrets.$inferSelect;
type RunConfigurationSecretOperationRow =
  typeof schema.runConfigurationSecretOperations.$inferSelect;

interface RunConfigurationRuntimeOperationRequestBase {
  operationId: string;
  projectId: string;
  configurationId: string;
  worktreeId: string;
  workerId: string;
}

export type RunConfigurationRuntimeOperationRequest =
  | (RunConfigurationRuntimeOperationRequestBase & {
      operation: Extract<RunConfigurationRuntimeOperation, "start" | "restart">;
      definitionRevision: string;
      codexEnvironmentRevision: string | null;
    })
  | (RunConfigurationRuntimeOperationRequestBase & {
      operation: Extract<RunConfigurationRuntimeOperation, "stop">;
      definitionRevision: null;
      codexEnvironmentRevision: null;
    });

export interface RunConfigurationStateRepositoryCollaborators {
  listRunConfigurationProtectedSecrets(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<Array<RunConfigurationProtectedSecret & { updatedAt: string }>>;
  nextProjectTabPosition(projectId: string): Promise<number>;
}

function runConfigurationSecretValueDigest(
  protectedValue: ProtectedSecretEnvelope,
): string {
  return createHash("sha256")
    .update(JSON.stringify(protectedValue))
    .digest("hex");
}

function replayedRunConfigurationSecretSetResult(
  operation: RunConfigurationSecretOperationRow,
): RunConfigurationSecretSetResult {
  if (operation.revision === null) {
    throw new Error("The Run configuration secret operation is incomplete.");
  }
  return runConfigurationSecretSetResultSchema.parse({
    operationId: operation.id,
    projectId: operation.projectId,
    replayed: true,
    secret: {
      reference: operation.reference,
      available: true,
      revision: operation.revision,
      updatedAt: toISOString(operation.createdAt),
    },
  });
}

function toRunConfigurationRuntime(
  runtime: RunConfigurationRuntimeRow,
): RunConfigurationRuntime {
  return {
    id: runtime.id,
    projectId: runtime.projectId,
    configurationId: runtime.configurationId,
    worktreeId: runtime.worktreeId,
    workerId: runtime.workerId,
    terminalId: runtime.terminalId,
    definitionRevision: runtime.definitionRevision,
    codexEnvironmentRevision: runtime.codexEnvironmentRevision,
    generation: runtime.generation,
    requestedOperationId: runtime.requestedOperationId,
    state: runtime.state,
    startedAt: runtime.startedAt ? toISOString(runtime.startedAt) : null,
    endedAt: runtime.endedAt ? toISOString(runtime.endedAt) : null,
    exitCode: runtime.exitCode,
    signal: runtime.signal,
    failure: runtime.failure,
    createdAt: toISOString(runtime.createdAt),
    updatedAt: toISOString(runtime.updatedAt),
  };
}

function toRunConfigurationRuntimeOperation(
  operation: RunConfigurationRuntimeOperationRow,
): RunConfigurationRuntimeOperationRecord {
  return {
    id: operation.id,
    projectId: operation.projectId,
    configurationId: operation.configurationId,
    worktreeId: operation.worktreeId,
    runtimeId: operation.runtimeId,
    workerId: operation.workerId,
    operation: operation.operation,
    outcome: operation.outcome,
    generation: operation.generation,
    definitionRevision: operation.definitionRevision,
    codexEnvironmentRevision: operation.codexEnvironmentRevision,
    createdAt: toISOString(operation.createdAt),
  };
}

function toRunConfigurationSecretSummary(
  secret: RunConfigurationSecretRow,
): RunConfigurationSecretSummary {
  return {
    reference: secret.reference,
    available: true,
    revision: secret.revision,
    updatedAt: toISOString(secret.updatedAt),
  };
}

function toRunConfigurationProtectedSecret(
  secret: RunConfigurationSecretRow,
): RunConfigurationProtectedSecret {
  return {
    reference: secret.reference,
    revision: secret.revision,
    protectedValue: secret.protectedValue,
  };
}

export class RunConfigurationStateRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: RunConfigurationStateRepositoryCollaborators,
  ) {}

  async listRunConfigurationSecretSummaries(
    ownerId: string,
    projectId: string,
  ): Promise<RunConfigurationSecretSummary[]> {
    const rows = await this.database
      .select({ secret: schema.runConfigurationSecrets })
      .from(schema.runConfigurationSecrets)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationSecrets.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.runConfigurationSecrets.projectId, projectId))
      .orderBy(asc(schema.runConfigurationSecrets.reference))
      .limit(256);
    return runConfigurationSecretSummaryListSchema.parse(
      rows.map(({ secret }) => toRunConfigurationSecretSummary(secret)),
    );
  }

  async getRunConfigurationSecretStatuses(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<RunConfigurationSecretSummary[]> {
    const ordered = [...new Set(references)].slice(0, 256);
    if (ordered.length === 0) return [];
    const records =
      await this.collaborators.listRunConfigurationProtectedSecrets(
        ownerId,
        projectId,
        ordered,
      );
    const byReference = new Map(
      records.map((record) => [record.reference, record]),
    );
    return runConfigurationSecretSummaryListSchema.parse(
      ordered.map((reference) => {
        const record = byReference.get(reference);
        return record
          ? {
              reference,
              available: true,
              revision: record.revision,
              updatedAt: record.updatedAt,
            }
          : {
              reference,
              available: false,
              revision: null,
              updatedAt: null,
            };
      }),
    );
  }

  async listRunConfigurationProtectedSecrets(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<Array<RunConfigurationProtectedSecret & { updatedAt: string }>> {
    const unique = [...new Set(references)].slice(0, 256);
    if (unique.length === 0) return [];
    const rows = await this.database
      .select({ secret: schema.runConfigurationSecrets })
      .from(schema.runConfigurationSecrets)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationSecrets.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationSecrets.projectId, projectId),
          inArray(schema.runConfigurationSecrets.reference, unique),
        ),
      )
      .orderBy(asc(schema.runConfigurationSecrets.reference));
    const protectedSecrets = runConfigurationProtectedSecretListSchema.parse(
      rows.map(({ secret }) => toRunConfigurationProtectedSecret(secret)),
    );
    const updatedAt = new Map(
      rows.map(({ secret }) => [
        secret.reference,
        toISOString(secret.updatedAt),
      ]),
    );
    return protectedSecrets.map((secret) => ({
      ...secret,
      updatedAt: updatedAt.get(secret.reference)!,
    }));
  }

  async setRunConfigurationSecret(
    ownerId: string,
    projectId: string,
    raw: unknown,
  ): Promise<RunConfigurationSecretSetResult> {
    const request = runConfigurationSecretSetRequestSchema.parse(raw);
    const digest = runConfigurationSecretValueDigest(request.protectedValue);
    return this.database.transaction(async (transaction) => {
      const replay = (
        operation: RunConfigurationSecretOperationRow,
      ): RunConfigurationSecretSetResult => {
        if (
          operation.ownerId !== ownerId ||
          operation.projectId !== projectId ||
          operation.reference !== request.reference ||
          operation.protectedValueDigest !== digest
        ) {
          throw new Error(
            "The Run configuration secret operation identity is already in use.",
          );
        }
        return replayedRunConfigurationSecretSetResult(operation);
      };

      const existingOperations = await transaction
        .select()
        .from(schema.runConfigurationSecretOperations)
        .where(
          eq(schema.runConfigurationSecretOperations.id, request.operationId),
        )
        .limit(1);
      if (existingOperations[0]) return replay(existingOperations[0]);

      const now = new Date();
      const claimed = await transaction
        .insert(schema.runConfigurationSecretOperations)
        .values({
          id: request.operationId,
          ownerId,
          projectId,
          reference: request.reference,
          revision: null,
          protectedValueDigest: digest,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: schema.runConfigurationSecretOperations.id,
        })
        .returning();
      if (!claimed[0]) {
        const raced = await transaction
          .select()
          .from(schema.runConfigurationSecretOperations)
          .where(
            eq(schema.runConfigurationSecretOperations.id, request.operationId),
          )
          .limit(1);
        if (!raced[0]) {
          throw new Error(
            "Could not recover the Run configuration secret operation.",
          );
        }
        return replay(raced[0]);
      }

      const projects = await transaction
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projects[0]) {
        throw new Error("The Run configuration secret project was not found.");
      }

      const secrets = await transaction
        .insert(schema.runConfigurationSecrets)
        .values({
          id: randomUUID(),
          ownerId,
          projectId,
          reference: request.reference,
          protectedValue: request.protectedValue,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.runConfigurationSecrets.projectId,
            schema.runConfigurationSecrets.reference,
          ],
          set: {
            ownerId,
            protectedValue: request.protectedValue,
            revision: sql`${schema.runConfigurationSecrets.revision} + 1`,
            updatedAt: now,
          },
        })
        .returning();
      const secret = secrets[0];
      if (!secret) {
        throw new Error("Could not store the Run configuration secret.");
      }
      const completed = await transaction
        .update(schema.runConfigurationSecretOperations)
        .set({ revision: secret.revision })
        .where(
          and(
            eq(schema.runConfigurationSecretOperations.id, request.operationId),
            isNull(schema.runConfigurationSecretOperations.revision),
          ),
        )
        .returning();
      if (!completed[0]) {
        throw new Error(
          "Could not complete the Run configuration secret operation.",
        );
      }
      return runConfigurationSecretSetResultSchema.parse({
        operationId: request.operationId,
        projectId,
        replayed: false,
        secret: toRunConfigurationSecretSummary(secret),
      });
    });
  }

  async getRunConfigurationRuntimeOperationResult(
    ownerId: string,
    operationId: string,
  ): Promise<RunConfigurationRuntimeOperationResult | null> {
    const rows = await this.database
      .select({ operation: schema.runConfigurationRuntimeOperations })
      .from(schema.runConfigurationRuntimeOperations)
      .where(
        and(
          eq(schema.runConfigurationRuntimeOperations.id, operationId),
          eq(schema.runConfigurationRuntimeOperations.ownerId, ownerId),
        ),
      )
      .limit(1);
    const operation = rows[0]?.operation;
    if (!operation) return null;
    const runtimeRows = operation.runtimeId
      ? await this.database
          .select({ runtime: schema.runConfigurationRuntimes })
          .from(schema.runConfigurationRuntimes)
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, operation.runtimeId),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            ),
          )
          .limit(1)
      : [];
    return {
      operation: toRunConfigurationRuntimeOperation(operation),
      replayed: true,
      runtime: runtimeRows[0]
        ? toRunConfigurationRuntime(runtimeRows[0].runtime)
        : null,
    };
  }

  async requestRunConfigurationRuntimeOperation(
    ownerId: string,
    input: RunConfigurationRuntimeOperationRequest,
  ): Promise<RunConfigurationRuntimeOperationResult> {
    const terminalPosition = await this.collaborators.nextProjectTabPosition(
      input.projectId,
    );
    return this.database.transaction(async (transaction) => {
      const operationRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimeOperations)
        .where(
          eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
        )
        .limit(1);

      const replay = async (
        row: RunConfigurationRuntimeOperationRow,
      ): Promise<RunConfigurationRuntimeOperationResult> => {
        if (
          row.ownerId !== ownerId ||
          row.projectId !== input.projectId ||
          row.configurationId !== input.configurationId ||
          row.worktreeId !== input.worktreeId ||
          row.workerId !== input.workerId ||
          row.operation !== input.operation ||
          row.definitionRevision !== input.definitionRevision ||
          row.codexEnvironmentRevision !== input.codexEnvironmentRevision
        ) {
          throw new Error(
            "The Run configuration operation identity is already in use.",
          );
        }
        const runtimeRows = row.runtimeId
          ? await transaction
              .select()
              .from(schema.runConfigurationRuntimes)
              .where(
                and(
                  eq(schema.runConfigurationRuntimes.id, row.runtimeId),
                  eq(schema.runConfigurationRuntimes.ownerId, ownerId),
                ),
              )
              .limit(1)
          : [];
        return {
          operation: toRunConfigurationRuntimeOperation(row),
          replayed: true,
          runtime: runtimeRows[0]
            ? toRunConfigurationRuntime(runtimeRows[0])
            : null,
        };
      };

      if (operationRows[0]) return replay(operationRows[0]);

      const placements = await transaction
        .select({ workerId: schema.projectWorktrees.workerId })
        .from(schema.projectWorktrees)
        .innerJoin(
          schema.projectSources,
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.projectSources.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(
          and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projectWorktrees.workerId, input.workerId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!placements[0]) {
        throw new Error(
          "The Run configuration target worktree is not available on that worker.",
        );
      }

      let runtimeRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.projectId, input.projectId),
            eq(
              schema.runConfigurationRuntimes.configurationId,
              input.configurationId,
            ),
            eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId),
          ),
        )
        .limit(1)
        .for("update");

      if (!runtimeRows[0] && input.operation === "start") {
        await transaction
          .insert(schema.runConfigurationRuntimes)
          .values({
            id: randomUUID(),
            ownerId,
            projectId: input.projectId,
            configurationId: input.configurationId,
            worktreeId: input.worktreeId,
            workerId: input.workerId,
            definitionRevision: input.definitionRevision,
            codexEnvironmentRevision: input.codexEnvironmentRevision,
            generation: 0,
            requestedOperationId: input.operationId,
            state: "idle",
          })
          .onConflictDoNothing({
            target: [
              schema.runConfigurationRuntimes.projectId,
              schema.runConfigurationRuntimes.configurationId,
              schema.runConfigurationRuntimes.worktreeId,
            ],
          });
        runtimeRows = await transaction
          .select()
          .from(schema.runConfigurationRuntimes)
          .where(
            and(
              eq(schema.runConfigurationRuntimes.projectId, input.projectId),
              eq(
                schema.runConfigurationRuntimes.configurationId,
                input.configurationId,
              ),
              eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId),
            ),
          )
          .limit(1)
          .for("update");
      }

      const racedOperationRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimeOperations)
        .where(
          eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
        )
        .limit(1);
      if (racedOperationRows[0]) return replay(racedOperationRows[0]);

      let current = runtimeRows[0];
      let outcome: RunConfigurationRuntimeOperationRecord["outcome"];
      let generation = current?.generation ?? 0;
      if (!current) {
        outcome = "not-active";
      } else if (
        input.operation === "start" &&
        ["starting", "running", "restarting", "stopping"].includes(
          current.state,
        )
      ) {
        outcome = "already-active";
      } else if (input.operation === "restart") {
        if (
          ["starting", "running", "restarting", "stopping"].includes(
            current.state,
          )
        ) {
          outcome = "accepted";
          generation += 1;
        } else {
          outcome = "not-active";
        }
      } else if (input.operation === "stop") {
        if (current.state === "stopping") {
          outcome = "already-stopping";
        } else if (
          ["starting", "running", "restarting"].includes(current.state)
        ) {
          outcome = "accepted";
        } else {
          outcome = "not-active";
        }
      } else {
        outcome = "accepted";
        generation += 1;
      }

      if (
        current &&
        ["starting", "running", "restarting", "stopping"].includes(
          current.state,
        ) &&
        current.workerId !== input.workerId
      ) {
        throw new Error(
          "The active Run configuration runtime belongs to another worker.",
        );
      }

      if (current && outcome === "accepted" && current.terminalId === null) {
        const terminalId = current.id;
        const insertedTerminals = await transaction
          .insert(schema.terminals)
          .values({
            id: terminalId,
            projectId: input.projectId,
            kind: "run-configuration",
            protectedLabel: null,
            protectedState: null,
            position: terminalPosition,
            status: "running",
            activeWorkerId: input.workerId,
            worktreeId: input.worktreeId,
            linkedChatId: null,
            runConfigurationId: input.configurationId,
            runConfigurationRuntimeId: current.id,
            serviceEnabled: false,
          })
          .onConflictDoNothing({ target: schema.terminals.id })
          .returning();
        const terminalRows = insertedTerminals[0]
          ? insertedTerminals
          : await transaction
              .select()
              .from(schema.terminals)
              .where(eq(schema.terminals.id, terminalId))
              .limit(1);
        const terminal = terminalRows[0];
        if (
          !terminal ||
          terminal.projectId !== input.projectId ||
          terminal.kind !== "run-configuration" ||
          terminal.activeWorkerId !== input.workerId ||
          terminal.worktreeId !== input.worktreeId ||
          terminal.runConfigurationId !== input.configurationId ||
          terminal.runConfigurationRuntimeId !== current.id
        ) {
          throw new Error(
            "The Run configuration terminal identity belongs to another surface.",
          );
        }
        const boundRows = await transaction
          .update(schema.runConfigurationRuntimes)
          .set({ terminalId, updatedAt: new Date() })
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, current.id),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
              isNull(schema.runConfigurationRuntimes.terminalId),
            ),
          )
          .returning();
        if (!boundRows[0]) {
          throw new Error("Could not bind the Run configuration terminal.");
        }
        current = boundRows[0];
        if (insertedTerminals[0]) {
          await attachProjectTab(transaction, {
            projectId: input.projectId,
            tabId: terminalId,
            tabKind: "terminal",
          });
        }
      }

      const insertedOperations = await transaction
        .insert(schema.runConfigurationRuntimeOperations)
        .values({
          id: input.operationId,
          ownerId,
          projectId: input.projectId,
          configurationId: input.configurationId,
          worktreeId: input.worktreeId,
          runtimeId: current?.id ?? null,
          workerId: input.workerId,
          operation: input.operation,
          outcome,
          generation,
          definitionRevision: input.definitionRevision,
          codexEnvironmentRevision: input.codexEnvironmentRevision,
        })
        .onConflictDoNothing({
          target: schema.runConfigurationRuntimeOperations.id,
        })
        .returning();
      if (!insertedOperations[0]) {
        const raced = await transaction
          .select()
          .from(schema.runConfigurationRuntimeOperations)
          .where(
            eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
          )
          .limit(1);
        if (!raced[0]) {
          throw new Error("Could not recover the Run configuration operation.");
        }
        return replay(raced[0]);
      }

      let updated = current;
      if (current && outcome === "accepted") {
        const nextState =
          input.operation === "start"
            ? "starting"
            : input.operation === "restart"
              ? "restarting"
              : "stopping";
        const launch = input.operation !== "stop";
        const updatedRows = await transaction
          .update(schema.runConfigurationRuntimes)
          .set({
            workerId: input.workerId,
            definitionRevision: launch
              ? input.definitionRevision
              : current.definitionRevision,
            codexEnvironmentRevision: launch
              ? input.codexEnvironmentRevision
              : current.codexEnvironmentRevision,
            generation,
            requestedOperationId: input.operationId,
            state: nextState,
            startedAt: launch ? null : current.startedAt,
            endedAt: null,
            exitCode: launch ? null : current.exitCode,
            signal: launch ? null : current.signal,
            failure: launch ? null : current.failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, current.id),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
              eq(
                schema.runConfigurationRuntimes.generation,
                current.generation,
              ),
              eq(schema.runConfigurationRuntimes.state, current.state),
            ),
          )
          .returning();
        if (!updatedRows[0]) {
          throw new Error(
            "The Run configuration runtime changed during the operation.",
          );
        }
        updated = updatedRows[0];
      }

      return {
        operation: toRunConfigurationRuntimeOperation(insertedOperations[0]),
        replayed: false,
        runtime: updated ? toRunConfigurationRuntime(updated) : null,
      };
    });
  }

  async getRunConfigurationRuntime(
    ownerId: string,
    projectId: string,
    configurationId: string,
    worktreeId: string,
  ): Promise<RunConfigurationRuntime | null> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationRuntimes.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          eq(schema.runConfigurationRuntimes.configurationId, configurationId),
          eq(schema.runConfigurationRuntimes.worktreeId, worktreeId),
        ),
      )
      .limit(1);
    return rows[0] ? toRunConfigurationRuntime(rows[0].runtime) : null;
  }

  async listRunConfigurationRuntimes(
    ownerId: string,
    projectId: string,
    input: {
      configurationId?: string;
      worktreeId?: string;
      limit?: number;
    } = {},
  ): Promise<RunConfigurationRuntime[]> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationRuntimes.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          input.configurationId
            ? eq(
                schema.runConfigurationRuntimes.configurationId,
                input.configurationId,
              )
            : undefined,
          input.worktreeId
            ? eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId)
            : undefined,
        ),
      )
      .orderBy(
        desc(
          sql<boolean>`${schema.runConfigurationRuntimes.state} IN ('starting', 'running', 'restarting', 'stopping')`,
        ),
        desc(schema.runConfigurationRuntimes.updatedAt),
        asc(schema.runConfigurationRuntimes.configurationId),
      )
      .limit(Math.min(256, Math.max(1, input.limit ?? 256)));
    return rows.map(({ runtime }) => toRunConfigurationRuntime(runtime));
  }

  async deleteRunConfigurationRuntimes(
    ownerId: string,
    projectId: string,
    runtimeIds: readonly string[],
  ): Promise<number> {
    if (runtimeIds.length === 0) return 0;
    const rows = await this.database
      .delete(schema.runConfigurationRuntimes)
      .where(
        and(
          eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          inArray(schema.runConfigurationRuntimes.id, [...runtimeIds]),
          sql`${schema.runConfigurationRuntimes.state} NOT IN ('starting', 'running', 'restarting', 'stopping')`,
        ),
      )
      .returning({ id: schema.runConfigurationRuntimes.id });
    return rows.length;
  }

  async listActiveRunConfigurationRuntimeIdentitiesForWorker(
    ownerId: string,
    workerId: string,
  ): Promise<RunConfigurationRuntimeWorkerIdentity[]> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .where(
        and(
          eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          eq(schema.runConfigurationRuntimes.workerId, workerId),
          inArray(schema.runConfigurationRuntimes.state, [
            "starting",
            "running",
            "restarting",
            "stopping",
          ]),
        ),
      )
      .orderBy(asc(schema.runConfigurationRuntimes.createdAt))
      .limit(256);
    return rows.map(({ runtime }) => ({
      runtimeId: runtime.id,
      projectId: runtime.projectId,
      configurationId: runtime.configurationId,
      worktreeId: runtime.worktreeId,
      workerId: runtime.workerId,
      definitionRevision: runtime.definitionRevision,
      codexEnvironmentRevision: runtime.codexEnvironmentRevision,
      generation: runtime.generation,
      operationId: runtime.requestedOperationId,
      terminalId: runtime.terminalId,
    }));
  }

  async applyRunConfigurationRuntimeObservation(
    ownerId: string,
    workerId: string,
    observation: RunConfigurationRuntimeWorkerObservation,
  ): Promise<RunConfigurationRuntimeObservationApplyResult | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.id, observation.runtimeId),
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          ),
        )
        .limit(1)
        .for("update");
      const current = rows[0];
      if (!current || current.workerId !== workerId) return null;
      if (
        current.projectId !== observation.projectId ||
        current.configurationId !== observation.configurationId ||
        current.worktreeId !== observation.worktreeId ||
        current.definitionRevision !== observation.definitionRevision ||
        current.codexEnvironmentRevision !==
          observation.codexEnvironmentRevision ||
        current.terminalId !== observation.terminalId
      ) {
        throw new Error(
          "Worker Run configuration state does not match its durable identity.",
        );
      }
      const runtime = () => toRunConfigurationRuntime(current);
      if (observation.generation < current.generation) {
        return {
          applied: false,
          reason: "stale-generation",
          runtime: runtime(),
        };
      }
      if (observation.generation > current.generation) {
        throw new Error(
          "Worker Run configuration generation is ahead of durable state.",
        );
      }
      if (observation.operationId !== current.requestedOperationId) {
        return {
          applied: false,
          reason: "stale-operation",
          runtime: runtime(),
        };
      }
      if (observation.state === current.state) {
        return { applied: false, reason: "unchanged", runtime: runtime() };
      }

      const allowed: Record<
        RunConfigurationRuntime["state"],
        RunConfigurationRuntime["state"][]
      > = {
        idle: [],
        starting: ["running", "stopping", "exited", "failed", "lost"],
        running: ["stopping", "exited", "failed", "lost"],
        restarting: [
          "starting",
          "running",
          "stopping",
          "exited",
          "failed",
          "lost",
        ],
        stopping: ["idle", "exited", "failed", "lost"],
        exited: [],
        failed: [],
        lost: [],
      };
      if (!allowed[current.state].includes(observation.state)) {
        return {
          applied: false,
          reason: "invalid-transition",
          runtime: runtime(),
        };
      }

      const updatedRows = await transaction
        .update(schema.runConfigurationRuntimes)
        .set({
          state: observation.state,
          startedAt: observation.startedAt
            ? new Date(observation.startedAt)
            : current.startedAt,
          endedAt: observation.endedAt ? new Date(observation.endedAt) : null,
          exitCode: observation.exitCode,
          signal: observation.signal,
          failure: observation.failure,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.runConfigurationRuntimes.id, current.id),
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.generation, current.generation),
            eq(
              schema.runConfigurationRuntimes.requestedOperationId,
              current.requestedOperationId,
            ),
            eq(schema.runConfigurationRuntimes.state, current.state),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(
          "The Run configuration runtime changed during its observation.",
        );
      }
      return {
        applied: true,
        reason: "applied",
        runtime: toRunConfigurationRuntime(updated),
      };
    });
  }
}
