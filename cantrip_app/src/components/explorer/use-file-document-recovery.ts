import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDocument } from "@/lib/api/file-documents";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { DocumentRecoverySession } from "@/lib/document-recovery-session";
import { readWorkspaceDeviceIdentity } from "@/lib/workspace-device-identity";
import { clearSensitiveBytes } from "@cantrip/crypto";
import { validateExplorerTransfer } from "./explorer-transfer-state";
import type { ExplorerTransferState } from "./explorer-view";

export interface FileDocumentRecovery {
  checkpoint(state: ExplorerTransferState): Promise<void>;
  closeCommitted(): Promise<void>;
}

/** Staged destinations do not acquire a writer revision until ownership commits.
 * The source must finish its checkpoint before that commit. */
export function useFileDocumentRecovery(
  document: FileDocument,
  tabId: string,
  staging: boolean,
) {
  const [attempt, setAttempt] = useState(0);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [status, setStatus] = useState<{
    loaded: boolean;
    initial?: ExplorerTransferState;
    error?: string;
  }>({ loaded: false });
  // Allocate during render so a child's first checkpoint can wait for the
  // parent's load effect, rather than fail because effects run child-first.
  const gate = useMemo(() => {
    let resolve!: (session: DocumentRecoverySession) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DocumentRecoverySession>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject, runs: 0 };
  }, [
    document.id,
    document.path,
    document.projectId,
    document.workerId,
    document.worktreeId,
    tabId,
    staging,
    attempt,
  ]);
  const latest = useRef<ExplorerTransferState | null>(null);
  const closed = useRef(false);
  const live = useRef(false);
  const report = useCallback((error: unknown) => {
    if (live.current)
      setStatus((current) => ({
        ...current,
        error:
          error instanceof Error ? error.message : "Document recovery failed.",
      }));
  }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (staging) return;
    const run = ++gate.runs;
    let cancelled = false;
    const identity = getClientSessionIdentitySnapshot();
    const load = async () => {
      if (!identity)
        throw new Error("Document recovery requires a signed-in account.");
      const { workspaceId } = await readWorkspaceDeviceIdentity(
        identity,
        document.projectId,
      );
      if (!clientSessionIdentityMatches(identity))
        throw new Error("Document recovery account changed.");
      const session = new DocumentRecoverySession({
        serverId: identity.serverId,
        ownerId: identity.userId,
        workspaceId,
        projectId: document.projectId,
        workerId: document.workerId,
        worktreeId: document.worktreeId,
        documentId: document.id,
        tabId,
      });
      const initial = await session.load((bytes) =>
        validateExplorerTransfer(JSON.parse(new TextDecoder().decode(bytes)), {
          serverId: identity.serverId,
          ownerId: identity.userId,
          explorerId: tabId,
          documentId: document.id,
          documentPath: document.path,
          projectId: document.projectId,
          workerId: document.workerId,
          worktreeId: document.worktreeId,
        }),
      );
      if (cancelled || !clientSessionIdentityMatches(identity)) {
        session.dispose();
        throw new Error("Document recovery view changed during restoration.");
      }
      setStatus({ loaded: true, initial: initial ?? undefined });
      return session;
    };
    const operation = load();
    void operation.then(
      (session) => {
        if (run === gate.runs) gate.resolve(session);
      },
      (error) => {
        if (run === gate.runs) gate.reject(error);
        if (!cancelled) report(error);
      },
    );
    // Do not clear or dispose a successfully loaded session on unmount:
    // a captured confirmed-close finalizer can still need to write its tombstone.
    // Sessions own no listeners/handles; queued writes fence encryption identity.
    return () => {
      cancelled = true;
    };
  }, [
    document.id,
    document.path,
    document.projectId,
    document.workerId,
    document.worktreeId,
    tabId,
    staging,
    gate,
    report,
  ]);

  const checkpoint = useCallback(
    async (state: ExplorerTransferState) => {
      if (closed.current) throw new Error("Document view was closed.");
      latest.current = state;
      if (staging) return;
      const bytes = new TextEncoder().encode(JSON.stringify(state));
      if (live.current) setPendingWrites((count) => count + 1);
      try {
        const session = await gate.promise;
        await session.checkpoint(bytes);
        if (live.current)
          setStatus((current) => ({ ...current, error: undefined }));
      } catch (error) {
        report(error);
        throw error;
      } finally {
        clearSensitiveBytes(bytes);
        if (live.current) setPendingWrites((count) => count - 1);
      }
    },
    [staging, report, gate],
  );
  const closeCommitted = useCallback(async () => {
    closed.current = true;
    const session = await gate.promise;
    await session.renewEncryption();
    await session.checkpoint(null);
  }, [gate]);
  const retry = useCallback(() => {
    if (status.loaded && latest.current)
      void gate.promise
        .then(async (session) => {
          await session.renewEncryption();
          // Use the latest edit after renewal, not the text at the click time.
          if (latest.current) await checkpoint(latest.current);
        })
        .catch(report);
    else setAttempt((value) => value + 1);
  }, [status.loaded, checkpoint, gate, report]);
  return {
    ...status,
    pending: pendingWrites > 0,
    checkpoint,
    closeCommitted,
    retry,
  };
}
