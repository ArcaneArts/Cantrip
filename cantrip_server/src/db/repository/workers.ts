import { randomUUID } from "node:crypto";

import {
  unavailableCodeCapabilities,
  unavailableCodeGraphWorkerStatus,
  unavailableManagedFolderCapabilities,
  unavailableManagedWebRuntimeCapabilities,
  unavailableProjectReplicaCapabilities,
  unavailableStandaloneChatCapabilities,
  unavailableWorkerEncryptionStatus,
  type WorkerCredentialScope,
  type WorkerCredentialSummary,
  type WorkerEnrollmentCodeStatus,
  type WorkerHeartbeat,
  type WorkerManagementSource,
  type WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

const SERVER_ID_STATE_KEY = "server-id";

export const WORKER_ONLINE_WINDOW_MS = 30_000;

type WorkerCredentialRow = typeof schema.workerCredentials.$inferSelect;

export interface ActiveWorkerCredential {
  id: string;
  ownerId: string;
  scopes: WorkerCredentialScope[];
  workerId: string;
}

export interface WorkerEnrollmentProvision {
  credential: WorkerCredentialSummary;
  ownerId: string;
  replacedWorkerId: string | null;
  revokedCredentialIds: string[];
  worker: WorkerSummary;
}

export interface WorkerManagementRecord {
  activeCredentialCount: number;
  credentialCount: number;
  runtimeName: string;
  sources: WorkerManagementSource[];
  worker: WorkerSummary;
}

export class WorkerEnrollmentError extends Error {}

function toWorkerCredentialSummary(
  credential: WorkerCredentialRow,
  now = new Date(),
): WorkerCredentialSummary {
  return {
    id: credential.id,
    workerId: credential.workerId,
    label: credential.label,
    scopes: credential.scopes as WorkerCredentialScope[],
    createdAt: toISOString(credential.createdAt),
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    revokedReason: credential.revokedReason,
    active:
      credential.revokedAt === null &&
      (credential.expiresAt === null || credential.expiresAt > now),
  };
}

export function toWorkerSummary(
  worker: typeof schema.workers.$inferSelect,
): WorkerSummary {
  return {
    workerId: worker.id,
    name: worker.displayName ?? worker.name,
    platform: worker.platform,
    architecture: worker.architecture,
    codexVersion: worker.codexVersion,
    codexRuntime: worker.codexRuntime,
    remoteSurfaces: worker.remoteSurfaceCapabilities,
    directBroker: worker.directBrokerAdvertisement,
    code: worker.codeCapabilities,
    codegraph: worker.codegraphStatus,
    webRuntimes: worker.webRuntimeCapabilities,
    encryption: worker.encryptionStatus,
    projectReplicas: worker.projectReplicaCapabilities,
    managedFolders: worker.managedFolderCapabilities,
    standaloneChat: worker.standaloneChatCapabilities,
    chatRelocation: worker.chatRelocationCapability,
    externalCodexHistory: worker.externalCodexHistoryCapability,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= WORKER_ONLINE_WINDOW_MS,
  };
}

export class WorkerRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async getOrCreateServerId(): Promise<string> {
    await this.database
      .insert(schema.systemState)
      .values({ key: SERVER_ID_STATE_KEY, value: { id: randomUUID() } })
      .onConflictDoNothing({ target: schema.systemState.key });
    const authoritative = await this.database
      .select({ value: schema.systemState.value })
      .from(schema.systemState)
      .where(eq(schema.systemState.key, SERVER_ID_STATE_KEY))
      .limit(1);
    const serverId = (authoritative[0]?.value as { id?: unknown } | undefined)
      ?.id;
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw new Error("The authoritative server identity is unavailable.");
    }
    return serverId;
  }

  async createWorkerEnrollmentCode(input: {
    codeHash: string;
    createdBySessionId: string | null;
    expiresAt: Date;
    label: string | null;
    ownerId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.insert(schema.workerEnrollmentCodes).values({
      id,
      ownerId: input.ownerId,
      createdBySessionId: input.createdBySessionId,
      codeHash: input.codeHash,
      label: input.label,
      expiresAt: input.expiresAt,
    });
    return id;
  }

  async findReusableWorkerId(
    ownerId: string,
    candidateWorkerIds: readonly string[],
  ): Promise<string | null> {
    const candidates = [...new Set(candidateWorkerIds)].slice(0, 64);
    if (candidates.length === 0) return null;

    const activeSourceCount = sql<number>`count(${schema.projectSources.id})`;
    const rows = await this.database
      .select({
        id: schema.workers.id,
        sourceCount: activeSourceCount,
      })
      .from(schema.workers)
      .leftJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.workerId, schema.workers.id),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          inArray(schema.workers.id, candidates),
          sql`${schema.workers.unlinkedAt} IS NOT NULL`,
        ),
      )
      .groupBy(schema.workers.id, schema.workers.lastSeenAt)
      .orderBy(desc(activeSourceCount), desc(schema.workers.lastSeenAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async getWorkerEnrollmentCodeStatus(
    ownerId: string,
    enrollmentCodeId: string,
  ): Promise<WorkerEnrollmentCodeStatus | null> {
    const rows = await this.database
      .select()
      .from(schema.workerEnrollmentCodes)
      .where(
        and(
          eq(schema.workerEnrollmentCodes.id, enrollmentCodeId),
          eq(schema.workerEnrollmentCodes.ownerId, ownerId),
        ),
      )
      .limit(1);
    const code = rows[0];
    if (!code) return null;
    return {
      id: code.id,
      label: code.label,
      expiresAt: toISOString(code.expiresAt),
      status: code.consumedAt
        ? "paired"
        : code.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "pending",
    };
  }

  async exchangeWorkerEnrollmentCode(input: {
    codeHash: string;
    credentialHash: string;
    credentialId: string;
    heartbeat: WorkerHeartbeat;
    replacement: { workerId: string; credentialHash: string } | null;
    scopes: WorkerCredentialScope[];
  }): Promise<WorkerEnrollmentProvision> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const codes = await transaction
        .select()
        .from(schema.workerEnrollmentCodes)
        .where(
          and(
            eq(schema.workerEnrollmentCodes.codeHash, input.codeHash),
            isNull(schema.workerEnrollmentCodes.consumedAt),
            gt(schema.workerEnrollmentCodes.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const code = codes[0];
      if (!code) {
        throw new WorkerEnrollmentError(
          "This worker link code is invalid, expired, or already used.",
        );
      }

      if (input.replacement?.workerId === input.heartbeat.workerId) {
        throw new WorkerEnrollmentError(
          "A worker cannot replace its own identity during enrollment.",
        );
      }
      let revokedCredentialIds: string[] = [];
      if (input.replacement) {
        const replacementCredentials = await transaction
          .select()
          .from(schema.workerCredentials)
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.replacement.workerId),
              eq(
                schema.workerCredentials.secretHash,
                input.replacement.credentialHash,
              ),
              isNull(schema.workerCredentials.revokedAt),
              or(
                isNull(schema.workerCredentials.expiresAt),
                gt(schema.workerCredentials.expiresAt, now),
              ),
            ),
          )
          .for("update")
          .limit(1);
        const replacementCredential = replacementCredentials[0];
        if (!replacementCredential) {
          throw new WorkerEnrollmentError(
            "The previous worker credential could not authorize reassignment.",
          );
        }
        const replacementWorkers = await transaction
          .select()
          .from(schema.workers)
          .where(eq(schema.workers.id, input.replacement.workerId))
          .for("update")
          .limit(1);
        const replacementWorker = replacementWorkers[0];
        if (
          !replacementWorker ||
          replacementWorker.ownerId !== replacementCredential.ownerId
        ) {
          throw new WorkerEnrollmentError(
            "The previous worker identity and credential do not match.",
          );
        }
        const revokedRows = await transaction
          .update(schema.workerCredentials)
          .set({
            revokedAt: now,
            revokedReason: "Worker reassigned to another account.",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.replacement.workerId),
              isNull(schema.workerCredentials.revokedAt),
            ),
          )
          .returning({ id: schema.workerCredentials.id });
        revokedCredentialIds = revokedRows.map(({ id }) => id);
        await transaction
          .update(schema.workers)
          .set({ unlinkedAt: now, updatedAt: now })
          .where(eq(schema.workers.id, input.replacement.workerId));
      }

      const existingWorkers = await transaction
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, input.heartbeat.workerId))
        .for("update")
        .limit(1);
      const existingWorker = existingWorkers[0];
      if (existingWorker && existingWorker.ownerId !== code.ownerId) {
        throw new WorkerEnrollmentError(
          "This worker identity is already owned by another account.",
        );
      }
      if (existingWorker) {
        const activeCredentials = await transaction
          .select({ id: schema.workerCredentials.id })
          .from(schema.workerCredentials)
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.heartbeat.workerId),
              isNull(schema.workerCredentials.revokedAt),
              or(
                isNull(schema.workerCredentials.expiresAt),
                gt(schema.workerCredentials.expiresAt, now),
              ),
            ),
          )
          .limit(1);
        if (activeCredentials[0]) {
          throw new WorkerEnrollmentError(
            "This worker identity is already enrolled. Rotate its credential instead.",
          );
        }
      }

      const consumed = await transaction
        .update(schema.workerEnrollmentCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.workerEnrollmentCodes.id, code.id),
            isNull(schema.workerEnrollmentCodes.consumedAt),
          ),
        )
        .returning({ id: schema.workerEnrollmentCodes.id });
      if (!consumed[0]) {
        throw new WorkerEnrollmentError(
          "This worker link code was already used.",
        );
      }

      const workerValues = {
        name: input.heartbeat.name,
        platform: input.heartbeat.platform,
        architecture: input.heartbeat.architecture,
        codexVersion: input.heartbeat.codexVersion,
        codexRuntime: input.heartbeat.codexRuntime,
        remoteSurfaceCapabilities: input.heartbeat.remoteSurfaces,
        directBrokerAdvertisement: input.heartbeat.directBroker,
        codeCapabilities: input.heartbeat.code ?? unavailableCodeCapabilities,
        codegraphStatus:
          input.heartbeat.codegraph ?? unavailableCodeGraphWorkerStatus,
        webRuntimeCapabilities:
          input.heartbeat.webRuntimes ??
          unavailableManagedWebRuntimeCapabilities,
        encryptionStatus:
          input.heartbeat.encryption ?? unavailableWorkerEncryptionStatus,
        projectReplicaCapabilities:
          input.heartbeat.projectReplicas ??
          unavailableProjectReplicaCapabilities,
        managedFolderCapabilities:
          input.heartbeat.managedFolders ??
          unavailableManagedFolderCapabilities,
        standaloneChatCapabilities:
          input.heartbeat.standaloneChat ??
          unavailableStandaloneChatCapabilities,
        chatRelocationCapability: input.heartbeat.chatRelocation ?? false,
        externalCodexHistoryCapability:
          input.heartbeat.externalCodexHistory ?? false,
        startedAt: new Date(input.heartbeat.startedAt),
        lastSeenAt: now,
        unlinkedAt: null,
        updatedAt: now,
      };
      const workerRows = existingWorker
        ? await transaction
            .update(schema.workers)
            .set(workerValues)
            .where(
              and(
                eq(schema.workers.id, input.heartbeat.workerId),
                eq(schema.workers.ownerId, code.ownerId),
              ),
            )
            .returning()
        : await transaction
            .insert(schema.workers)
            .values({
              id: input.heartbeat.workerId,
              ownerId: code.ownerId,
              ...workerValues,
            })
            .returning();
      const credentialRows = await transaction
        .insert(schema.workerCredentials)
        .values({
          id: input.credentialId,
          ownerId: code.ownerId,
          workerId: input.heartbeat.workerId,
          secretHash: input.credentialHash,
          label: code.label,
          scopes: input.scopes,
          lastUsedAt: now,
        })
        .returning();
      return {
        ownerId: code.ownerId,
        replacedWorkerId: input.replacement?.workerId ?? null,
        revokedCredentialIds,
        worker: toWorkerSummary(firstOrThrow(workerRows, "enrolling a worker")),
        credential: toWorkerCredentialSummary(
          firstOrThrow(credentialRows, "creating a worker credential"),
          now,
        ),
      };
    });
  }

  async authenticateWorkerCredential(
    secretHash: string,
    workerId: string,
    requiredScope: WorkerCredentialScope,
  ): Promise<ActiveWorkerCredential | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.workerCredentials)
        .where(
          and(
            eq(schema.workerCredentials.secretHash, secretHash),
            eq(schema.workerCredentials.workerId, workerId),
            isNull(schema.workerCredentials.revokedAt),
            or(
              isNull(schema.workerCredentials.expiresAt),
              gt(schema.workerCredentials.expiresAt, now),
            ),
          ),
        )
        .for("update")
        .limit(1);
      const credential = rows[0];
      if (!credential) return null;
      const scopes = credential.scopes as WorkerCredentialScope[];
      if (!scopes.includes(requiredScope)) return null;
      await transaction
        .update(schema.workerCredentials)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(schema.workerCredentials.id, credential.id));
      return {
        id: credential.id,
        ownerId: credential.ownerId,
        scopes,
        workerId: credential.workerId,
      };
    });
  }

  async listWorkerCredentials(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerCredentialSummary[] | null> {
    if (!(await this.getWorker(ownerId, workerId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workerCredentials)
      .where(
        and(
          eq(schema.workerCredentials.ownerId, ownerId),
          eq(schema.workerCredentials.workerId, workerId),
        ),
      )
      .orderBy(desc(schema.workerCredentials.createdAt));
    return rows.map((row) => toWorkerCredentialSummary(row));
  }

  async rotateWorkerCredential(input: {
    credentialHash: string;
    credentialId: string;
    label: string | null;
    ownerId: string;
    scopes: WorkerCredentialScope[];
    workerId: string;
  }): Promise<WorkerCredentialSummary | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!workers[0]) return null;
      const active = await transaction
        .select({ id: schema.workerCredentials.id })
        .from(schema.workerCredentials)
        .where(
          and(
            eq(schema.workerCredentials.ownerId, input.ownerId),
            eq(schema.workerCredentials.workerId, input.workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        )
        .orderBy(desc(schema.workerCredentials.createdAt));
      if (!active[0]) {
        throw new WorkerEnrollmentError(
          "Development bootstrap workers do not have rotatable credentials.",
        );
      }
      await transaction
        .update(schema.workerCredentials)
        .set({
          revokedAt: now,
          revokedReason: "rotated",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workerCredentials.ownerId, input.ownerId),
            eq(schema.workerCredentials.workerId, input.workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        );
      const created = await transaction
        .insert(schema.workerCredentials)
        .values({
          id: input.credentialId,
          ownerId: input.ownerId,
          workerId: input.workerId,
          secretHash: input.credentialHash,
          label: input.label,
          scopes: input.scopes,
          replacesCredentialId: active[0]?.id ?? null,
        })
        .returning();
      return toWorkerCredentialSummary(
        firstOrThrow(created, "rotating a worker credential"),
        now,
      );
    });
  }

  async revokeWorkerCredential(
    ownerId: string,
    workerId: string,
    credentialId: string,
    reason = "revoked by owner",
  ): Promise<WorkerCredentialSummary | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.workerCredentials)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.workerCredentials.id, credentialId),
          eq(schema.workerCredentials.workerId, workerId),
          eq(schema.workerCredentials.ownerId, ownerId),
          isNull(schema.workerCredentials.revokedAt),
        ),
      )
      .returning();
    return rows[0] ? toWorkerCredentialSummary(rows[0], now) : null;
  }

  async recordWorker(
    ownerId: string,
    heartbeat: WorkerHeartbeat,
  ): Promise<WorkerSummary> {
    const now = new Date();
    const values = {
      name: heartbeat.name,
      platform: heartbeat.platform,
      architecture: heartbeat.architecture,
      codexVersion: heartbeat.codexVersion,
      codexRuntime: heartbeat.codexRuntime,
      remoteSurfaceCapabilities: heartbeat.remoteSurfaces,
      directBrokerAdvertisement: heartbeat.directBroker,
      codeCapabilities: heartbeat.code ?? unavailableCodeCapabilities,
      codegraphStatus: heartbeat.codegraph ?? unavailableCodeGraphWorkerStatus,
      webRuntimeCapabilities:
        heartbeat.webRuntimes ?? unavailableManagedWebRuntimeCapabilities,
      encryptionStatus:
        heartbeat.encryption ?? unavailableWorkerEncryptionStatus,
      projectReplicaCapabilities:
        heartbeat.projectReplicas ?? unavailableProjectReplicaCapabilities,
      managedFolderCapabilities:
        heartbeat.managedFolders ?? unavailableManagedFolderCapabilities,
      standaloneChatCapabilities:
        heartbeat.standaloneChat ?? unavailableStandaloneChatCapabilities,
      chatRelocationCapability: heartbeat.chatRelocation ?? false,
      externalCodexHistoryCapability: heartbeat.externalCodexHistory ?? false,
      startedAt: new Date(heartbeat.startedAt),
      lastSeenAt: now,
      unlinkedAt: null,
      updatedAt: now,
    };
    let result = await this.database
      .update(schema.workers)
      .set(values)
      .where(
        and(
          eq(schema.workers.id, heartbeat.workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .returning();
    if (!result[0]) {
      try {
        result = await this.database
          .insert(schema.workers)
          .values({ id: heartbeat.workerId, ownerId, ...values })
          .returning();
      } catch (error) {
        const currentOwnerId = await this.getWorkerOwnerId(heartbeat.workerId);
        if (currentOwnerId && currentOwnerId !== ownerId) {
          throw new WorkerEnrollmentError(
            "This worker identity belongs to another account.",
          );
        }
        if (currentOwnerId === ownerId) {
          result = await this.database
            .update(schema.workers)
            .set(values)
            .where(
              and(
                eq(schema.workers.id, heartbeat.workerId),
                eq(schema.workers.ownerId, ownerId),
              ),
            )
            .returning();
        } else {
          throw error;
        }
      }
    }
    return toWorkerSummary(
      firstOrThrow(result, "recording a worker heartbeat"),
    );
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .orderBy(asc(schema.workers.name));
    return rows.map(toWorkerSummary);
  }

  async getWorker(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toWorkerSummary(rows[0]) : null;
  }

  async listWorkerManagement(
    ownerId: string,
  ): Promise<WorkerManagementRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .orderBy(asc(schema.workers.name));
    return Promise.all(
      rows.map(async (worker) => {
        const [credentials, sources] = await Promise.all([
          this.database
            .select({ revokedAt: schema.workerCredentials.revokedAt })
            .from(schema.workerCredentials)
            .where(
              and(
                eq(schema.workerCredentials.ownerId, ownerId),
                eq(schema.workerCredentials.workerId, worker.id),
              ),
            ),
          this.database
            .select({
              projectReplicaId: schema.projectSources.id,
              projectId: schema.projects.id,
              nameWithOwner: sql<string>`coalesce(${schema.projects.githubRepositoryFullName}, ${schema.projectSources.displayPath})`,
              displayPath: schema.projectSources.displayPath,
            })
            .from(schema.projectSources)
            .innerJoin(
              schema.projects,
              eq(schema.projects.id, schema.projectSources.projectId),
            )
            .where(
              and(
                eq(schema.projectSources.workerId, worker.id),
                eq(schema.projects.ownerId, ownerId),
                isNull(schema.projectSources.removedAt),
              ),
            )
            .orderBy(asc(schema.projects.githubRepositoryFullName)),
        ]);
        return {
          activeCredentialCount: credentials.filter(
            ({ revokedAt }) => !revokedAt,
          ).length,
          credentialCount: credentials.length,
          runtimeName: worker.name,
          sources,
          worker: toWorkerSummary(worker),
        };
      }),
    );
  }

  async updateWorkerDisplayName(
    ownerId: string,
    workerId: string,
    name: string,
  ): Promise<WorkerSummary | null> {
    const rows = await this.database
      .update(schema.workers)
      .set({ displayName: name, updatedAt: new Date() })
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .returning();
    return rows[0] ? toWorkerSummary(rows[0]) : null;
  }

  async unlinkWorker(ownerId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!workers[0]) return false;
      await transaction
        .update(schema.workerCredentials)
        .set({
          revokedAt: now,
          revokedReason: "worker unlinked by owner",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workerCredentials.ownerId, ownerId),
            eq(schema.workerCredentials.workerId, workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        );
      const unlinked = await transaction
        .update(schema.workers)
        .set({ unlinkedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .returning({ id: schema.workers.id });
      return Boolean(unlinked[0]);
    });
  }

  async getWorkerOwnerId(workerId: string): Promise<string | null> {
    const rows = await this.database
      .select({ ownerId: schema.workers.ownerId })
      .from(schema.workers)
      .where(eq(schema.workers.id, workerId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    const workers = await this.listWorkers(ownerId);
    return workers.filter((worker) => worker.online).length;
  }
}
