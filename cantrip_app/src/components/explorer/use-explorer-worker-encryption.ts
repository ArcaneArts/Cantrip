import {
  workerEncryptionMaterialFingerprint,
  type ExplorerSummary,
  type WorkerSummary,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { getWorkers } from "@/lib/api";
import type { ClientEncryptionSnapshot } from "@/lib/client-encryption";
import { clientEncryption } from "@/lib/client-encryption";
import type { ClientSessionContext } from "@/lib/client-session";
import { getClientSession } from "@/lib/client-session";
import {
  surfacePrivateStateWorkerCanAttempt,
  surfacePrivateStateWorkerReadiness,
  waitForSurfacePrivateStateWorkerEncryption,
} from "@/lib/surface-private-state-worker-encryption";

type ExplorerEncryptionBinding = Pick<
  ExplorerSummary,
  "activeWorkerId" | "id" | "projectId" | "worktreeId"
>;

type ExplorerWorkerEncryptionLease = {
  promise: Promise<void>;
  release(): void;
};

type ExplorerWorkerEncryptionRequest = {
  cancelled: boolean;
  consumers: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
};

const EXPLORER_ENCRYPTION_RELEASE_GRACE_MS = 1_500;

const explorerWorkerEncryptionRequests = new Map<
  string,
  ExplorerWorkerEncryptionRequest
>();

type ExplorerWorkerSecurityDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "startedAt" | "workerId"
>;

export function explorerWorkerSecurityFingerprint(
  worker: ExplorerWorkerSecurityDescriptor | null | undefined,
): string | null {
  if (!worker) return null;
  return JSON.stringify([
    worker.workerId,
    worker.online,
    worker.startedAt,
    workerEncryptionMaterialFingerprint(worker.encryption),
  ]);
}

export function explorerWorkerIdentityFingerprint(
  worker: ExplorerWorkerSecurityDescriptor | null | undefined,
): string | null {
  if (!worker) return null;
  return JSON.stringify([
    worker.workerId,
    worker.startedAt,
    worker.encryption.supported,
    worker.encryption.principalId,
  ]);
}

export function explorerWorkerEncryptionBindingKey(input: {
  encryption: ClientEncryptionSnapshot;
  explorer: ExplorerEncryptionBinding;
  session: ClientSessionContext | null;
  worker?: ExplorerWorkerSecurityDescriptor | null;
}): string {
  return JSON.stringify([
    input.explorer.id,
    input.explorer.projectId,
    input.explorer.worktreeId,
    input.explorer.activeWorkerId,
    input.session?.serverId ?? null,
    input.session?.user.id ?? null,
    input.encryption.status,
    input.encryption.clientId,
    input.encryption.identity?.serverId ?? null,
    input.encryption.identity?.ownerId ?? null,
    input.encryption.masterKeyRevision,
    explorerWorkerIdentityFingerprint(input.worker),
  ]);
}

export function explorerWorkerEncryptionContinuityKey(input: {
  encryption: ClientEncryptionSnapshot;
  explorer: ExplorerEncryptionBinding;
  session: ClientSessionContext | null;
  worker: ExplorerWorkerSecurityDescriptor;
}): string {
  return JSON.stringify([
    input.explorer.activeWorkerId,
    input.session?.serverId ?? null,
    input.session?.user.id ?? null,
    input.encryption.status,
    input.encryption.clientId,
    input.encryption.identity?.serverId ?? null,
    input.encryption.identity?.ownerId ?? null,
    input.encryption.masterKeyRevision,
    explorerWorkerIdentityFingerprint(input.worker),
  ]);
}

export function explorerWorkerEncryptionBindingReady(
  bindingKey: string,
  readyBindingKey: string | null,
): boolean {
  return bindingKey === readyBindingKey;
}

function acquireExplorerWorkerEncryption(
  authorizationKey: string,
  worker: ExplorerWorkerSecurityDescriptor,
): ExplorerWorkerEncryptionLease {
  let request = explorerWorkerEncryptionRequests.get(authorizationKey);
  if (!request || request.cancelled) {
    request = {
      cancelled: false,
      consumers: 0,
      evictionTimer: null,
      promise: Promise.resolve(),
    };
    const created = request;
    let initialWorker: ExplorerWorkerSecurityDescriptor | undefined = worker;
    created.promise = waitForSurfacePrivateStateWorkerEncryption({
      isCancelled: () => created.cancelled,
      loadWorker: async () => {
        if (initialWorker) {
          const current = initialWorker;
          initialWorker = undefined;
          return current;
        }
        return (await getWorkers()).find(
          (candidate) => candidate.workerId === worker.workerId,
        );
      },
    }).then(() => undefined);
    explorerWorkerEncryptionRequests.set(authorizationKey, created);
    const clearFailure = () => {
      if (explorerWorkerEncryptionRequests.get(authorizationKey) === created) {
        explorerWorkerEncryptionRequests.delete(authorizationKey);
      }
    };
    void created.promise.catch(clearFailure);
    request = created;
  }
  if (request.evictionTimer) clearTimeout(request.evictionTimer);
  request.evictionTimer = null;
  request.consumers += 1;
  const acquired = request;
  let released = false;
  return {
    promise: acquired.promise,
    release: () => {
      if (released) return;
      released = true;
      acquired.consumers = Math.max(0, acquired.consumers - 1);
      if (acquired.consumers !== 0 || acquired.evictionTimer) return;
      acquired.evictionTimer = setTimeout(() => {
        acquired.evictionTimer = null;
        if (acquired.consumers !== 0) return;
        acquired.cancelled = true;
        if (
          explorerWorkerEncryptionRequests.get(authorizationKey) === acquired
        ) {
          explorerWorkerEncryptionRequests.delete(authorizationKey);
        }
      }, EXPLORER_ENCRYPTION_RELEASE_GRACE_MS);
    },
  };
}

function invalidateExplorerWorkerEncryption(authorizationKey: string): void {
  const request = explorerWorkerEncryptionRequests.get(authorizationKey);
  if (!request) return;
  request.cancelled = true;
  if (request.evictionTimer) clearTimeout(request.evictionTimer);
  explorerWorkerEncryptionRequests.delete(authorizationKey);
}

export function resetExplorerWorkerEncryptionReadinessForTests(): void {
  for (const [authorizationKey] of explorerWorkerEncryptionRequests) {
    invalidateExplorerWorkerEncryption(authorizationKey);
  }
}

export function useExplorerWorkerEncryption(
  explorer: ExplorerEncryptionBinding | null,
  enabled = true,
): {
  bindingKey: string | null;
  continuityKey: string | null;
  error: string | null;
  ready: boolean;
  retry(): void;
} {
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const session = getClientSession();
  const workerId = explorer?.activeWorkerId ?? null;
  const {
    data: workers,
    isError: workersFailed,
    refetch: refetchWorkers,
  } = useQuery({
    enabled: Boolean(enabled && workerId),
    queryFn: getWorkers,
    queryKey: ["workers"],
  });
  const worker = workers?.find((candidate) => candidate.workerId === workerId);
  const workerSecurityFingerprint = explorerWorkerSecurityFingerprint(worker);
  const workerReadiness = surfacePrivateStateWorkerReadiness(
    worker,
    encryption,
  );
  const initialWorkerRef = useRef(worker);
  initialWorkerRef.current = worker;
  const bindingKey = explorer
    ? explorerWorkerEncryptionBindingKey({
        encryption,
        explorer,
        session,
        worker,
      })
    : null;
  const authorizationKey =
    explorer && worker
      ? explorerWorkerEncryptionContinuityKey({
          encryption,
          explorer,
          session,
          worker,
        })
      : null;
  const authorizationRequestKey =
    authorizationKey && workerSecurityFingerprint
      ? JSON.stringify([authorizationKey, workerSecurityFingerprint])
      : null;
  const [readyBinding, setReadyBinding] = useState<{
    attempt: number;
    bindingKey: string;
  } | null>(null);
  const [errorBinding, setErrorBinding] = useState<{
    bindingKey: string;
    message: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identityMatchesSession = Boolean(
    session &&
    encryption.status === "ready" &&
    encryption.masterKeyRevision !== null &&
    encryption.identity?.serverId === session.serverId &&
    encryption.identity.ownerId === session.user.id,
  );
  const authorizationEnabled = Boolean(
    enabled &&
    identityMatchesSession &&
    authorizationKey &&
    authorizationRequestKey &&
    bindingKey &&
    workerId &&
    surfacePrivateStateWorkerCanAttempt(workerReadiness),
  );

  useEffect(() => {
    if (
      !authorizationEnabled ||
      !authorizationRequestKey ||
      !bindingKey ||
      !workerId
    ) {
      setReadyBinding(null);
      setErrorBinding(null);
      return;
    }
    let disposed = false;
    setErrorBinding(null);
    const initialWorker = initialWorkerRef.current;
    if (!initialWorker) return;
    const lease = acquireExplorerWorkerEncryption(
      authorizationRequestKey,
      initialWorker,
    );
    void lease.promise
      .then(() => {
        if (!disposed) {
          setReadyBinding({
            attempt,
            bindingKey,
          });
        }
      })
      .catch(() => {
        if (!disposed) {
          setErrorBinding({
            bindingKey,
            message: "Explorer encryption is unavailable for this worker.",
          });
        }
      });
    return () => {
      disposed = true;
      lease.release();
    };
  }, [
    attempt,
    authorizationEnabled,
    authorizationRequestKey,
    bindingKey,
    workerId,
    workerSecurityFingerprint,
  ]);
  const retry = useCallback(() => {
    if (authorizationRequestKey) {
      invalidateExplorerWorkerEncryption(authorizationRequestKey);
    }
    void refetchWorkers();
    setAttempt((current) => current + 1);
  }, [authorizationRequestKey, refetchWorkers]);

  const authorizationError =
    errorBinding?.bindingKey === bindingKey ? errorBinding.message : null;

  return {
    bindingKey,
    continuityKey: authorizationKey,
    error:
      authorizationError ??
      (enabled && explorer && workersFailed
        ? "Explorer encryption could not inspect this worker."
        : null),
    ready: Boolean(
      authorizationEnabled &&
      workerReadiness === "ready" &&
      bindingKey &&
      readyBinding?.attempt === attempt &&
      explorerWorkerEncryptionBindingReady(
        bindingKey,
        readyBinding?.bindingKey ?? null,
      ),
    ),
    retry,
  };
}
