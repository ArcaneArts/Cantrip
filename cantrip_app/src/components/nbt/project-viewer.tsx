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
export function NbtProjectViewer(props: FileViewerProps) {
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot),
    [localFile, setLocalFile] = useState<File | null>(null),
    epoch = useRef(0);
  // An owner may outlive its React view while another window still uses it.
  // Keep its source and write closures bound to this exact document access.
  const access = props.fileAccess;
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  useEffect(
    () =>
      onClientSessionIdentityChanged(() => {
        void clearNbtSessions();
        setIdentity(getClientSessionIdentitySnapshot());
        setLocalFile(null);
      }),
    [],
  );
  useEffect(() => {
    if (encryption.status !== "ready") {
      setLocalFile(null);
      void clearNbtSessions();
    }
  }, [encryption.status]);
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
  const saveTarget = useMemo(
    () => (localFile ? undefined : { path: props.path, write }),
    [localFile, props.path, write],
  );
  const openRecovery = useCallback(async () => {
    if (!identity || !clientSessionIdentityMatches(identity))
      throw new Error("The NBT recovery account changed.");
    const { workspaceId } = await readWorkspaceDeviceIdentity(
      identity,
      props.projectId,
    );
    const vault = await openNbtRecoveryVault({
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
    });
    if (!clientSessionIdentityMatches(identity))
      throw new Error("The NBT recovery account changed.");
    return {
      ...vault,
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
  }, [
    identity,
    props.projectId,
    props.workerId,
    props.worktreeId,
    props.documentId,
    props.path,
  ]);
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
      if (localFile) return localFile;
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
      props.revision,
    ],
  );
  if (!identity || encryption.status !== "ready")
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Unlock this account to view NBT documents.
      </div>
    );
  const scope = JSON.stringify([
    identity,
    props.documentId ?? props.explorerId,
    props.explorerId,
    props.path,
    props.worktreeId,
    props.revision,
    localFile ? "local-" + epoch.current : "project",
  ]);
  return (
    <NbtBrowser
      key={scope}
      openSource={openSource}
      scope={scope}
      active={props.active}
      openRecovery={localFile ? undefined : openRecovery}
      readOnly={props.readOnly}
      onSessionChange={props.onSessionChange}
      saveTarget={saveTarget}
      saveAsTarget={saveAsTarget}
      onOpenDocument={props.onOpenDocument}
      label={localFile ? localFile.name : "NBT"}
      onReady={props.onReady}
      onError={props.onError}
      onLocalFile={(file) => {
        epoch.current++;
        setLocalFile(file);
      }}
    />
  );
}
