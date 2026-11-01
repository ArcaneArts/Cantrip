import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FileViewerProps } from "@/components/files/file-viewers";
import { clientEncryption } from "@/lib/client-encryption";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { openProtectedBinarySource } from "@/lib/binary-file-source";
import { executeExplorerOperation } from "@/lib/api/files";
import { NbtBrowser } from "./browser";
import { clearNbtSessions } from "@/lib/nbt/session-registry";
import type { NbtBinaryTransport } from "@/lib/nbt/save";
import { createFileDocument } from "@/lib/api/file-documents";
import { documentFileAccess } from "@/lib/file-access";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import { openNbtRecoveryVault } from "@/lib/nbt/recovery";
import { readWorkspaceDeviceIdentity } from "@/lib/workspace-device-identity";
import { useNbtLocalDocument } from "./use-local-document";
import { openRecoveredNbtSource } from "@/lib/nbt/local-source";
import { blobNbtSource } from "@cantrip/nbt";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
export function NbtProjectViewer(props: FileViewerProps) {
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot);
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const security = useRef({ snapshot: encryption, epoch: 0 });
  if (security.current.snapshot !== encryption)
    security.current = {
      snapshot: encryption,
      epoch: security.current.epoch + 1,
    };
  useEffect(
    () =>
      onClientSessionIdentityChanged(() => {
        void clearNbtSessions();
        setIdentity(getClientSessionIdentitySnapshot());
      }),
    [],
  );
  useEffect(() => {
    if (encryption.status !== "ready") {
      void clearNbtSessions();
    }
  }, [encryption.status]);
  if (!identity || encryption.status !== "ready")
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Unlock this account to view NBT documents.
      </div>
    );
  return (
    <ScopedNbtProjectViewer
      key={JSON.stringify([
        identity,
        security.current.epoch,
        props.explorerId,
        props.documentId,
        props.projectId,
        props.workerId,
        props.worktreeId,
        props.path,
      ])}
      {...props}
      identity={identity}
      securityScope={security.current.epoch}
    />
  );
}
function ScopedNbtProjectViewer(
  props: FileViewerProps & {
    identity: NonNullable<ReturnType<typeof getClientSessionIdentitySnapshot>>;
    securityScope: number;
  },
) {
  // The keyed scope makes identity immutable for retained owner factories.
  const [identity] = useState(props.identity),
    access = props.fileAccess;
  const write = useCallback<NbtBinaryTransport>(
    async (content, signal) => {
      if (!identity || !clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      if (access?.binaryWrite) return access.binaryWrite(content, signal);
      const result = await executeExplorerOperation(
        props.explorerId,
        content,
        undefined,
        undefined,
        {
          workerId: props.workerId,
          projectId: props.projectId,
          worktreeId: props.worktreeId,
        },
        signal,
      );
      if (!clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      if (result.type !== "explorer.binary.write")
        throw new Error("Unexpected NBT binary save result.");
      return result.value;
    },
    [
      identity,
      props.explorerId,
      props.workerId,
      props.projectId,
      props.worktreeId,
      access,
    ],
  );
  const openBinding = useCallback(async () => {
    if (!identity || !clientSessionIdentityMatches(identity))
      throw new Error("The NBT recovery account changed.");
    const { workspaceId } = await readWorkspaceDeviceIdentity(
      identity,
      props.projectId,
    );
    if (!clientSessionIdentityMatches(identity))
      throw new Error("The NBT recovery account changed.");
    return {
      serverId: identity.serverId,
      ownerId: identity.userId,
      workspaceId,
      projectId: props.projectId,
      workerId: props.workerId,
      worktreeId: props.worktreeId,
      documentId:
        props.documentId ??
        surfaceTitleEncryption.fileDocumentId({
          projectId: props.projectId,
          workerId: props.workerId,
          worktreeId: props.worktreeId,
          path: props.path,
        }),
    };
  }, [
    identity,
    props.projectId,
    props.workerId,
    props.worktreeId,
    props.documentId,
    props.path,
  ]);
  const openVault = useCallback(
    async (localId?: string) => {
      const binding = await openBinding();
      const vault = await openNbtRecoveryVault({
        ...binding,
        ...(localId ? { documentId: "local-nbt-v1:" + localId } : {}),
      });
      if (!clientSessionIdentityMatches(identity))
        throw new Error("The NBT recovery account changed.");
      return {
        ...vault,
        preserveBaseline: Boolean(localId),
        assertCurrent() {
          vault.assertCurrent();
          if (!clientSessionIdentityMatches(identity))
            throw new Error("The NBT recovery account changed.");
        },
        onInvalidate(notify: () => void) {
          const encryption = vault.onInvalidate(notify),
            session = onClientSessionIdentityChanged(notify);
          return () => {
            encryption();
            session();
          };
        },
      };
    },
    [identity, openBinding],
  );
  const local = useNbtLocalDocument(openBinding, props.explorerId, true),
    origin = local.snapshot?.origin,
    localFile = local.snapshot?.file,
    preparing = Boolean(local.snapshot?.preparing || local.snapshot?.blocked);
  const openRecovery = useCallback(
    () => openVault(origin?.id),
    [openVault, origin?.id],
  );
  const saveTarget = useMemo(
    () => (origin ? undefined : { path: props.path, write }),
    [origin, props.path, write],
  );
  const localReady = useCallback(
    (client: NbtDocumentClient, signal: AbortSignal) =>
      local.document?.ready(origin?.id, client, signal),
    [local.document, origin?.id],
  );
  const failed = useCallback(
    (error: unknown) => {
      void local.document?.failed(origin?.id, error);
      props.onError?.(error);
    },
    [local.document, origin?.id, props.onError],
  );
  const discardSource = useCallback(
    () => local.document!.discard(),
    [local.document],
  );
  const saveAsTarget = useCallback(
    async (path: string) => {
      if (!identity || !clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      const document = await createFileDocument({
        id: surfaceTitleEncryption.fileDocumentId({
          projectId: props.projectId,
          workerId: props.workerId,
          worktreeId: props.worktreeId,
          path,
        }),
        projectId: props.projectId,
        workerId: props.workerId,
        worktreeId: props.worktreeId,
        path,
      });
      if (!clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      const write = documentFileAccess(document).binaryWrite!;
      return ((request, signal) => {
        if (!clientSessionIdentityMatches(identity))
          throw new Error("The NBT document account changed.");
        return write(request, signal);
      }) satisfies NbtBinaryTransport;
    },
    [identity, props.projectId, props.workerId, props.worktreeId],
  );
  const openSource = useCallback(
    async (signal: AbortSignal) => {
      if (origin) {
        if (localFile)
          return { ...blobNbtSource(localFile), version: "local/" + origin.id };
        return openRecoveredNbtSource(await openVault(origin.id), signal);
      }
      if (!identity || !clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      if (access?.binary) return access.binary(props.path, signal);
      return openProtectedBinarySource(
        props.path,
        async (offset, limit, version, requestSignal) => {
          const result = await executeExplorerOperation(
            props.explorerId,
            {
              type: "explorer.binary.read",
              path: props.path,
              offset,
              limit,
              version,
            },
            undefined,
            undefined,
            {
              workerId: props.workerId,
              projectId: props.projectId,
              worktreeId: props.worktreeId,
            },
            requestSignal,
          );
          if (result.type !== "explorer.binary")
            throw new Error("Unexpected NBT binary result.");
          return result.value;
        },
        signal,
        () => {
          if (!clientSessionIdentityMatches(identity))
            throw new Error("The NBT document account changed.");
        },
      );
    },
    [
      access,
      props.path,
      props.explorerId,
      props.workerId,
      props.projectId,
      props.worktreeId,
      identity,
      localFile,
      origin,
      openVault,
      props.revision,
    ],
  );
  if (!local.document)
    return (
      <div
        role={local.error ? "alert" : "status"}
        className="p-4 text-xs text-muted-foreground"
      >
        {local.error ? (
          <>
            {local.error instanceof Error
              ? local.error.message
              : "Local NBT recovery could not be read."}{" "}
            <button type="button" onClick={local.retry}>
              Retry local recovery
            </button>
          </>
        ) : (
          "Opening NBT recovery…"
        )}
      </div>
    );
  const scope = JSON.stringify([
    identity,
    props.securityScope,
    props.documentId ?? props.explorerId,
    props.explorerId,
    props.path,
    props.worktreeId,
    props.revision,
    origin ? "local/" + origin.id : "project",
  ]);
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-nbt-source={origin ? "local" : "project"}
    >
      {local.snapshot?.error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 p-3 text-xs text-destructive"
        >
          <span>{local.snapshot.error}</span>
          <button
            type="button"
            onClick={() => void local.document!.retry().catch(failed)}
          >
            Retry local recovery
          </button>
        </div>
      ) : null}
      <NbtBrowser
        key={scope}
        openSource={openSource}
        scope={scope}
        active={props.active}
        openRecovery={openRecovery}
        preparingSource={preparing}
        onClientReady={localReady}
        onDiscardSource={origin ? discardSource : undefined}
        readOnly={props.readOnly}
        onSessionChange={props.onSessionChange}
        initialViewState={preparing ? undefined : props.initialViewState}
        saveTarget={saveTarget}
        saveAsTarget={saveAsTarget}
        onOpenDocument={props.onOpenDocument}
        label={origin ? origin.name + " · local" : "NBT"}
        onReady={props.onReady}
        onError={failed}
        onLocalFile={(file) => local.document!.select(file)}
      />
    </div>
  );
}
