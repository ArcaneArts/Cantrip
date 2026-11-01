import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  NbtDocumentClient,
  NbtDocumentSource,
} from "@cantrip/nbt/document";
import { openNbtDocument } from "@/lib/nbt/document";
import { nbtFormat } from "./format";
const empty = () => null,
  subscribeEmpty = () => () => {};
export function useNbtClient(
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>,
  scope: string,
  profile: string,
  compression: string,
  active: boolean,
) {
  const owner = useMemo(() => ({}), [openSource, scope, profile, compression]);
  const [session, setSession] = useState<{
      owner: object;
      client: NbtDocumentClient;
    } | null>(null),
    [error, setError] = useState<string | null>(null);
  const client = session?.owner === owner ? session.client : null;
  useEffect(() => {
    const controller = new AbortController();
    let current: NbtDocumentClient | undefined,
      input: Blob | NbtDocumentSource | undefined,
      disposed = false;
    setSession(null);
    setError(null);
    void (async () => {
      input = await openSource(controller.signal);
      controller.signal.throwIfAborted();
      const header =
        input instanceof Blob
          ? new Uint8Array(await input.slice(0, 8).arrayBuffer())
          : await input.read(0, 8, controller.signal);
      controller.signal.throwIfAborted();
      const format = nbtFormat(profile, compression, header, input.size ?? 0);
      current = await openNbtDocument(input, {
        binding:
          scope + "/" + ("version" in input ? String(input.version) : "local"),
        format,
        cacheBytes: 4 * 1024 ** 2,
        indexPages: 32,
      });
      if (disposed) {
        await current.close();
        return;
      }
      setSession({ owner, client: current });
    })().catch((reason) => {
      if (!current && input && !(input instanceof Blob)) input.close?.();
      if (!disposed)
        setError(
          reason instanceof Error
            ? reason.message
            : "NBT file could not be opened.",
        );
    });
    return () => {
      disposed = true;
      controller.abort();
      if (current) void current.close().catch(() => {});
      else if (input && !(input instanceof Blob)) input.close?.();
    };
  }, [openSource, scope, profile, compression, owner]);
  const status = useSyncExternalStore(
    client?.subscribe ?? subscribeEmpty,
    client?.getSnapshot ?? empty,
    empty,
  );
  useEffect(() => {
    if (client && status?.root)
      void client
        .setPaused(!active)
        .catch((reason) =>
          setError(
            reason instanceof Error
              ? reason.message
              : "NBT indexing could not be paused.",
          ),
        );
  }, [client, active, Boolean(status?.root)]);
  return { client, status, error };
}
