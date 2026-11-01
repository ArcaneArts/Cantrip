import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  NbtDocumentSource,
  NbtDocumentClient,
} from "@cantrip/nbt/document";
import { openNbtDocument } from "@/lib/nbt/document";
import {
  acquireNbtSession,
  type NbtViewSession,
} from "@/lib/nbt/session-registry";
import { nbtFormat } from "./format";
import type { NbtRecoveryVault } from "@/lib/nbt/recovery";
const empty = () => null,
  subscribeEmpty = () => () => {};
export async function openNbtViewerClient(
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>,
  key: string,
  profile: string,
  compression: string,
  signal = new AbortController().signal,
  openRecovery?: () => Promise<NbtRecoveryVault>,
  onCreated?: (client: NbtDocumentClient) => void,
) {
  let input: Blob | NbtDocumentSource | undefined;
  try {
    const vault = await openRecovery?.();
    signal.throwIfAborted();
    const recovered = await vault?.inspect();
    signal.throwIfAborted();
    if (recovered)
      return await openNbtDocument(
        null,
        {
          binding: key + "/recovered",
          format: recovered.format,
          version: recovered.version,
          recovery: vault ? { id: vault.id, key: vault.key } : undefined,
          cacheBytes: 4 * 1024 ** 2,
          indexPages: 32,
        },
        signal,
        onCreated,
      );
    input = await openSource(signal);
    signal.throwIfAborted();
    const header =
      input instanceof Blob
        ? new Uint8Array(await input.slice(0, 8).arrayBuffer())
        : await input.read(0, 8, signal);
    signal.throwIfAborted();
    const format = nbtFormat(profile, compression, header, input.size ?? 0);
    return await openNbtDocument(
      input,
      {
        binding:
          key + "/" + ("version" in input ? String(input.version) : "local"),
        format,
        version: "version" in input ? input.version : "local",
        cacheBytes: 4 * 1024 ** 2,
        indexPages: 32,
        ...(vault ? { recovery: { id: vault.id, key: vault.key } } : {}),
      },
      signal,
      onCreated,
    );
  } catch (error) {
    if (input && !(input instanceof Blob)) input.close?.();
    throw error;
  }
}
export function useNbtClient(
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>,
  scope: string,
  profile: string,
  compression: string,
  active: boolean,
  openRecovery?: () => Promise<NbtRecoveryVault>,
) {
  const key = JSON.stringify([scope, profile, compression]);
  const source = useRef(openSource);
  const recovery = useRef(openRecovery);
  source.current = openSource;
  recovery.current = openRecovery;
  const [session, setSession] = useState<{
      key: string;
      value: NbtViewSession;
    } | null>(null),
    [error, setError] = useState<string | null>(null);
  const lease = useRef<ReturnType<typeof acquireNbtSession> | null>(null);
  const value = session?.key === key ? session.value : null,
    client = value?.client ?? null;
  useEffect(() => {
    let disposed = false;
    setError(null);
    const current = acquireNbtSession(
      key,
      (signal, onCreated) =>
        openNbtViewerClient(
          source.current,
          key,
          profile,
          compression,
          signal,
          recovery.current,
          onCreated,
        ),
      active,
    );
    lease.current = current;
    void current.promise
      .then((value) => {
        if (!disposed) setSession({ key, value });
      })
      .catch((reason) => {
        if (!disposed)
          setError(
            reason instanceof Error
              ? reason.message
              : "NBT file could not be opened.",
          );
      });
    return () => {
      disposed = true;
      current.release();
      if (lease.current === current) lease.current = null;
    };
  }, [key]);
  useEffect(() => lease.current?.setActive(active), [active, key]);
  const status = useSyncExternalStore(
    client?.subscribe ?? subscribeEmpty,
    client?.getSnapshot ?? empty,
    empty,
  );
  const edit = useSyncExternalStore(
    client?.subscribeEdits ?? subscribeEmpty,
    client?.getEditSnapshot ?? empty,
    empty,
  );
  const progress = useSyncExternalStore(
    value?.subscribe ?? subscribeEmpty,
    value?.getSnapshot ?? empty,
    empty,
  );
  return {
    client,
    session: value,
    status,
    edit,
    progress,
    error,
    sessionKey: key,
  };
}
