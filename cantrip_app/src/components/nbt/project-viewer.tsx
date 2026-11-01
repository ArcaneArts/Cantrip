import {
  useCallback,
  useEffect,
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
export function NbtProjectViewer(props: FileViewerProps) {
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot),
    [localFile, setLocalFile] = useState<File | null>(null),
    epoch = useRef(0);
  const access = useRef(props.fileAccess);
  access.current = props.fileAccess;
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  useEffect(
    () =>
      onClientSessionIdentityChanged(() => {
        setIdentity(getClientSessionIdentitySnapshot());
        setLocalFile(null);
      }),
    [],
  );
  useEffect(() => {
    if (encryption.status !== "ready") setLocalFile(null);
  }, [encryption.status]);
  const openSource = useCallback(
    async (signal: AbortSignal) => {
      if (localFile) return localFile;
      if (!identity || !clientSessionIdentityMatches(identity))
        throw new Error("The NBT document account changed.");
      if (access.current?.binary)
        return access.current.binary(props.path, signal);
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
      props.fileAccess?.cacheKey,
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
    identity.serverId,
    identity.userId,
    props.documentId ?? props.explorerId,
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
