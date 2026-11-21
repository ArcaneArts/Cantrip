import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  gitManagedOperationContextSchema,
  gitManagedOperationRecordSchema,
  type GitManagedOperationContext,
  type GitManagedOperationRecord,
  type GitManagedOperationWorkerState,
} from "@cantrip/protocol";

const terminalStates = new Set(["completed", "failed", "aborted"]);

export type RepositoryManagedOperationScope = {
  ownerId: string;
  serverId: string;
  projectId: string;
  worktreeId: string;
  workerId: string;
};

function scopeKey(scope: RepositoryManagedOperationScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.ownerId,
        scope.workerId,
        scope.projectId,
        scope.worktreeId,
      ]),
    )
    .digest("hex");
}

export function managedOperationContext(
  record: GitManagedOperationRecord,
): GitManagedOperationContext {
  return gitManagedOperationContextSchema.parse(record);
}

export function managedOperationRecord(input: {
  existing?: GitManagedOperationRecord | null;
  id?: string;
  scope: RepositoryManagedOperationScope;
  state: GitManagedOperationWorkerState;
  now?: string;
}): GitManagedOperationRecord {
  const now = input.now ?? new Date().toISOString();
  return gitManagedOperationRecordSchema.parse({
    ...input.state,
    id: input.existing?.id ?? input.id ?? randomUUID(),
    projectId: input.scope.projectId,
    worktreeId: input.scope.worktreeId,
    workerId: input.scope.workerId,
    error: null,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    completedAt: terminalStates.has(input.state.state)
      ? (input.existing?.completedAt ?? now)
      : null,
  });
}

export function managedOperationIsActive(
  record: GitManagedOperationRecord | null,
): boolean {
  return Boolean(record && !terminalStates.has(record.state));
}

export class RepositoryManagedOperationStore {
  readonly #root: string;

  constructor(dataDirectory: string) {
    this.#root = path.resolve(dataDirectory, "repository-operations");
  }

  async get(
    scope: RepositoryManagedOperationScope,
  ): Promise<GitManagedOperationRecord | null> {
    try {
      const parsed = gitManagedOperationRecordSchema.parse(
        JSON.parse(await readFile(this.#path(scope), "utf8")),
      );
      if (
        parsed.projectId !== scope.projectId ||
        parsed.worktreeId !== scope.worktreeId ||
        parsed.workerId !== scope.workerId
      ) {
        throw new Error("Stored repository operation has the wrong scope.");
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw new Error("Stored repository operation is invalid.");
    }
  }

  async put(
    scope: RepositoryManagedOperationScope,
    record: GitManagedOperationRecord,
  ): Promise<void> {
    const parsed = gitManagedOperationRecordSchema.parse(record);
    if (
      parsed.projectId !== scope.projectId ||
      parsed.worktreeId !== scope.worktreeId ||
      parsed.workerId !== scope.workerId
    ) {
      throw new Error("Repository operation escaped its worker scope.");
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const destination = this.#path(scope);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  #path(scope: RepositoryManagedOperationScope): string {
    return path.join(this.#root, `${scopeKey(scope)}.json`);
  }
}
