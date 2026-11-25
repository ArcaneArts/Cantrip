import type {
  WorkerEncryptionComponentScope,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQueries } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { clientEncryption } from "./client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "./client-session";
import { authorizeWorkerEncryption } from "./worker-encryption-grants";
import { refreshWorkerEncryption } from "./api/worker-wire";

/** Backfill the optional capability on already-authorized workers after an
 * upgrade, including workers whose Chats are not mounted. Never approve a new
 * principal here or make Chat execution depend on this background operation. */
export function useAlertWorkerEncryption(workers: WorkerSummary[] = []) {
  useReadyChatWorkerContentGrant(workers, "alert-content");
}

export function useReadyChatWorkerContentGrant(
  workers: WorkerSummary[] = [],
  component: WorkerEncryptionComponentScope,
) {
  const snapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const identity = getClientSessionIdentitySnapshot();
  const revision = snapshot.masterKeyRevision;
  const eligible =
    identity &&
    snapshot.status === "ready" &&
    revision &&
    snapshot.identity?.serverId === identity.serverId &&
    snapshot.identity.ownerId === identity.userId
      ? workers.filter(
          (worker) =>
            worker.online &&
            worker.encryption.state === "ready" &&
            worker.encryption.principalId &&
            worker.encryption.grants.some(
              (g) =>
                g.component === "chat-content" && g.keyRevision === revision,
            ) &&
            !worker.encryption.grants.some(
              (g) => g.component === component && g.keyRevision === revision,
            ),
        )
      : [];
  useQueries({
    queries: eligible.map((worker) => ({
      queryKey: [
        component === "alert-content"
          ? "alert-worker-grant"
          : `chat-worker-grant:${component}`,
        identity!.serverId,
        identity!.userId,
        worker.workerId,
        worker.encryption.principalId,
        revision,
      ],
      queryFn: async () => {
        const assertCurrent = () => {
          if (!clientSessionIdentityMatches(identity!))
            throw new Error(
              "The account changed while authorizing worker content.",
            );
        };
        assertCurrent();
        await authorizeWorkerEncryption({
          approvePending: false,
          assertCurrent,
          components: [component],
          identity: { serverId: identity!.serverId, ownerId: identity!.userId },
          keyRevision: revision!,
          workerId: worker.workerId,
        });
        assertCurrent();
        await refreshWorkerEncryption(worker.workerId, {
          component,
          keyRevision: revision!,
        });
        return true;
      },
      staleTime: Infinity,
      retry: 1,
    })),
  });
}
