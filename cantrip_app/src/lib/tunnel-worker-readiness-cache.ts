import type { WorkerEncryptionStatus } from "@cantrip/protocol";

import type { ClientEncryptionSnapshot } from "./client-encryption";
import { ShortLivedRequestCache } from "./short-lived-request-cache";

export type TunnelWorkerReadinessCacheScope = {
  activeServerUrl: string;
  session: { serverId: string; user: { id: string } } | null;
  snapshot: ClientEncryptionSnapshot;
  workerEncryption: WorkerEncryptionStatus | null | undefined;
  workerId: string;
};

export function tunnelWorkerReadinessCacheKey(
  scope: TunnelWorkerReadinessCacheScope,
): string {
  const grants = scope.workerEncryption?.grants
    .filter(({ component }) => component === "tunnel-content")
    .map(({ keyRevision }) => keyRevision)
    .sort((left, right) => left - right);
  return JSON.stringify([
    1,
    scope.activeServerUrl,
    scope.session?.serverId ?? null,
    scope.session?.user.id ?? null,
    scope.workerId,
    scope.workerEncryption?.supported ?? null,
    scope.workerEncryption?.principalId ?? null,
    scope.workerEncryption?.state ?? null,
    grants ?? null,
    scope.snapshot.identity?.serverId ?? null,
    scope.snapshot.identity?.ownerId ?? null,
    scope.snapshot.status,
    scope.snapshot.masterKeyRevision,
  ]);
}

export class TunnelWorkerReadinessRequestCache {
  readonly #cache: ShortLivedRequestCache<WorkerEncryptionStatus>;

  constructor(ttlMs: number) {
    this.#cache = new ShortLivedRequestCache(ttlMs);
  }

  get(
    scope: TunnelWorkerReadinessCacheScope,
    load: () => Promise<WorkerEncryptionStatus>,
  ): Promise<WorkerEncryptionStatus> {
    return this.#cache.get(tunnelWorkerReadinessCacheKey(scope), load);
  }
}
