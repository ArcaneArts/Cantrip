import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NbtDocumentSource } from "@cantrip/nbt/document";
import { openNbtDocument } from "@/lib/nbt/document";
import {
  acquireNbtSession,
  type NbtViewSession,
} from "@/lib/nbt/session-registry";
import { nbtFormat } from "./format";
const empty = () => null,
  subscribeEmpty = () => () => {};
export async function openNbtViewerClient(
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>,
  key: string,
  profile: string,
  compression: string,
  signal = new AbortController().signal,
) {
  let input: Blob | NbtDocumentSource | undefined;
  try {
    input = await openSource(signal);
    signal.throwIfAborted();
    const header =
      input instanceof Blob
        ? new Uint8Array(await input.slice(0, 8).arrayBuffer())
        : await input.read(0, 8, signal);
    signal.throwIfAborted();
    const format = nbtFormat(profile, compression, header, input.size ?? 0);
    return await openNbtDocument(input, {
      binding:
        key + "/" + ("version" in input ? String(input.version) : "local"),
      format,
      version: "version" in input ? input.version : "local",
      cacheBytes: 4 * 1024 ** 2,
      indexPages: 32,
    });
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
) {
  const key = JSON.stringify([scope, profile, compression]);
  const source = useRef(openSource);
  source.current = openSource;
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
      (signal) =>
        openNbtViewerClient(source.current, key, profile, compression, signal),
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
