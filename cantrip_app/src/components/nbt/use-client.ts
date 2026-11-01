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
import { NbtSharedDocument } from "@/lib/nbt/shared-document";
import type { NbtInterpretation } from "@/lib/nbt/shared-owner";
import { NbtSaveController, type NbtBinaryTransport } from "@/lib/nbt/save";
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
  resolveWrite?: (path: string) => Promise<NbtBinaryTransport>,
) {
  const vault = await openRecovery?.();
  signal.throwIfAborted();
  const raw = async (
    choice: NbtInterpretation | undefined,
    signal: AbortSignal,
    onCreated?: (client: NbtDocumentClient) => void,
  ) => {
    let input: Blob | NbtDocumentSource | undefined;
    try {
      const recovered = !choice ? await vault?.inspect() : undefined;
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
      const format =
        choice?.format ??
        nbtFormat(
          choice?.profile ?? profile,
          choice?.compression ?? compression,
          header,
          input.size ?? 0,
        );
      return await openNbtDocument(
        input,
        {
          binding:
            key + "/" + ("version" in input ? String(input.version) : "local"),
          format,
          version: "version" in input ? input.version : "local",
          retainOriginal: !(input instanceof Blob) && input.retainOriginal,
          cacheBytes: 4 * 1024 ** 2,
          indexPages: 32,
          ...(vault && !choice
            ? { recovery: { id: vault.id, key: vault.key } }
            : {}),
        },
        signal,
        onCreated,
      );
    } catch (error) {
      if (input && !(input instanceof Blob)) input.close?.();
      throw error;
    }
  };
  if (!vault) return raw(undefined, signal, onCreated);
  return NbtSharedDocument.open(
    {
      id: vault.id,
      key: vault.key,
      assertCurrent: vault.assertCurrent,
      onInvalidate: vault.onInvalidate,
      factory: {
        create: raw,
        claim: vault.claim,
        async attachRecovery(client) {
          vault.assertCurrent();
          await client.attachRecovery({ id: vault.id, key: vault.key });
        },
        async reconcile(client) {
          const retained = client.getEditSnapshot()?.pendingSave;
          if (!retained) return;
          if (!retained.target || !resolveWrite)
            throw new Error("The pending NBT save destination is unavailable.");
          vault.assertCurrent();
          const controller = new NbtSaveController(
            client,
            retained.target.path,
            await resolveWrite(retained.target.path),
            undefined,
            { copy: retained.target.copy },
          );
          await controller.abandon();
          vault.assertCurrent();
        },
      },
    },
    signal,
    onCreated,
  );
}
export function useNbtClient(
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>,
  scope: string,
  profile: string,
  compression: string,
  active: boolean,
  openRecovery?: () => Promise<NbtRecoveryVault>,
  resolveWrite?: (path: string) => Promise<NbtBinaryTransport>,
) {
  const key = JSON.stringify(
    openRecovery ? [scope, "shared"] : [scope, profile, compression],
  );
  const source = useRef(openSource);
  const recovery = useRef(openRecovery);
  source.current = openSource;
  recovery.current = openRecovery;
  const transport = useRef(resolveWrite);
  transport.current = resolveWrite;
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
          transport.current,
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
