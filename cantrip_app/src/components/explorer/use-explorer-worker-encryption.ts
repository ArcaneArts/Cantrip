import type { ExplorerSummary } from "@cantrip/protocol";
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
import { waitForSurfacePrivateStateWorkerEncryption } from "@/lib/surface-private-state-worker-encryption";

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
  promise: Promise<void>;
};

const explorerWorkerEncryptionRequests = new Map<
  string,
  ExplorerWorkerEncryptionRequest
>();

export function explorerWorkerEncryptionBindingKey(input: {
  encryption: ClientEncryptionSnapshot;
  explorer: ExplorerEncryptionBinding;
  session: ClientSessionContext | null;
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
  ]);
}

function explorerWorkerEncryptionAuthorizationKey(input: {
  encryption: ClientEncryptionSnapshot;
  explorer: ExplorerEncryptionBinding;
  session: ClientSessionContext | null;
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
  workerId: string,
): ExplorerWorkerEncryptionLease {
  let request = explorerWorkerEncryptionRequests.get(authorizationKey);
  if (!request || request.cancelled) {
    request = {
      cancelled: false,
      consumers: 0,
      promise: Promise.resolve(),
    };
    const created = request;
    created.promise = waitForSurfacePrivateStateWorkerEncryption({
      isCancelled: () => created.cancelled,
      loadWorker: async () =>
        (await getWorkers()).find((worker) => worker.workerId === workerId),
    }).then(() => undefined);
    explorerWorkerEncryptionRequests.set(authorizationKey, created);
    const clear = () => {
      if (explorerWorkerEncryptionRequests.get(authorizationKey) === created) {
        explorerWorkerEncryptionRequests.delete(authorizationKey);
      }
    };
    void created.promise.then(clear, clear);
    request = created;
  }
  request.consumers += 1;
  const acquired = request;
  let released = false;
  return {
    promise: acquired.promise,
    release: () => {
      if (released) return;
      released = true;
      acquired.consumers = Math.max(0, acquired.consumers - 1);
      if (acquired.consumers === 0) acquired.cancelled = true;
    },
  };
}

export function useExplorerWorkerEncryption(
  explorer: ExplorerEncryptionBinding | null,
  enabled = true,
): {
  bindingKey: string | null;
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
  const bindingKey = explorer
    ? explorerWorkerEncryptionBindingKey({ encryption, explorer, session })
    : null;
  const authorizationKey = explorer
    ? explorerWorkerEncryptionAuthorizationKey({
        encryption,
        explorer,
        session,
      })
    : null;
  const workerId = explorer?.activeWorkerId ?? null;
  const [readyBinding, setReadyBinding] = useState<{
    bindingKey: string;
    version: number;
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
    bindingKey &&
    workerId,
  );
  const authorizationVersionRef = useRef(0);
  const wasAuthorizationEnabledRef = useRef(false);
  const activating =
    authorizationEnabled && !wasAuthorizationEnabledRef.current;

  useEffect(() => {
    if (
      !authorizationEnabled ||
      !authorizationKey ||
      !bindingKey ||
      !workerId
    ) {
      if (wasAuthorizationEnabledRef.current) {
        authorizationVersionRef.current += 1;
      }
      wasAuthorizationEnabledRef.current = false;
      setReadyBinding(null);
      setErrorBinding(null);
      return;
    }
    wasAuthorizationEnabledRef.current = true;
    const authorizationVersion = ++authorizationVersionRef.current;
    let disposed = false;
    setReadyBinding(null);
    setErrorBinding(null);
    const lease = acquireExplorerWorkerEncryption(authorizationKey, workerId);
    void lease.promise
      .then(() => {
        if (!disposed) {
          setReadyBinding({
            bindingKey,
            version: authorizationVersion,
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
  }, [attempt, authorizationEnabled, authorizationKey, bindingKey, workerId]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return {
    bindingKey,
    error:
      errorBinding?.bindingKey === bindingKey ? errorBinding.message : null,
    ready: Boolean(
      authorizationEnabled &&
      !activating &&
      bindingKey &&
      readyBinding?.version === authorizationVersionRef.current &&
      explorerWorkerEncryptionBindingReady(
        bindingKey,
        readyBinding?.bindingKey ?? null,
      ),
    ),
    retry,
  };
}
