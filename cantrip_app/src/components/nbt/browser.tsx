import { NbtEditActions } from "./edit-actions";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ArrowLeft, FileUp, Search } from "lucide-react";
import type { FileViewerSession } from "@/components/files/file-viewers";
import {
  acquireNbtSession,
  discardNbtSession,
} from "@/lib/nbt/session-registry";
import type { NbtBinaryTransport } from "@/lib/nbt/save";
import type { NbtRecoveryVault } from "@/lib/nbt/recovery";
import { nbtSharedDocument } from "@/lib/nbt/shared-document";
import type {
  NbtDisplayRow,
  NbtDocumentSource,
  NbtSearchResult,
} from "@cantrip/nbt/document";
import { openNbtViewerClient, useNbtClient } from "./use-client";
import { confirmEditorAction } from "@/lib/editor-confirmation";
import { NbtTree, type NbtAnchor } from "./tree";
import { NbtArray } from "./array";
import { NbtTable } from "./table";
import { NbtFind } from "./find";
import { nbtControl, NBT_PROFILES, NBT_TYPE_NAMES } from "./format";
import {
  NbtEditSheet,
  type NbtEditAction,
  type NbtEditRequest,
} from "./edit-sheet";

export function NbtBrowser({
  openSource,
  scope,
  active = true,
  label = "NBT",
  onReady,
  onError,
  onLocalFile,
  saveTarget,
  readOnly: externalReadOnly = false,
  onSessionChange,
  saveAsTarget,
  onOpenDocument,
  openRecovery,
}: {
  openSource: (signal: AbortSignal) => Promise<Blob | NbtDocumentSource>;
  scope: string;
  active?: boolean;
  label?: string;
  onReady?(): void;
  onError?(error: unknown): void;
  onLocalFile?(file: File): void;
  saveTarget?: { path: string; write: NbtBinaryTransport };
  readOnly?: boolean;
  onSessionChange?(session: FileViewerSession | null): void;
  saveAsTarget?(path: string): Promise<NbtBinaryTransport>;
  onOpenDocument?(path: string): void | Promise<void>;
  openRecovery?(): Promise<NbtRecoveryVault>;
}) {
  const [profile, setProfile] = useState("auto"),
    [compression, setCompression] = useState("auto"),
    [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set()),
    [selected, setSelected] = useState<NbtDisplayRow | null>(null),
    [target, setTarget] = useState<NbtDisplayRow | null>(null),
    [mode, setMode] = useState<"tree" | "array" | "table">("tree"),
    [anchor, setAnchor] = useState<NbtAnchor | null>(null),
    [arrayFocus, setArrayFocus] = useState<{
      index: number;
      nonce: number;
    } | null>(null),
    [find, setFind] = useState(false),
    [crumbs, setCrumbs] = useState<NbtDisplayRow[]>([]),
    [navigationError, setNavigationError] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [editRequest, setEditRequest] = useState<NbtEditRequest | null>(null),
    [epoch, setEpoch] = useState(0);
  const [saveAsPath, setSaveAsPath] = useState<string | null>(null),
    [copyNotice, setCopyNotice] = useState<string | null>(null),
    [copyError, setCopyError] = useState<string | null>(null);
  const [copyPreparing, setCopyPreparing] = useState(false),
    copyOpening = useRef(false);
  const resolveWrite = useCallback(
    async (path: string) => {
      if (saveTarget?.path === path) return saveTarget.write;
      if (saveAsTarget) return saveAsTarget(path);
      throw new Error("The NBT save destination is unavailable.");
    },
    [saveTarget, saveAsTarget],
  );
  const { client, session, status, edit, progress, error, sessionKey } =
      useNbtClient(
        openSource,
        scope + "/reload-" + epoch,
        profile,
        compression,
        active,
        openRecovery,
        resolveWrite,
      ),
    input = useRef<HTMLInputElement>(null),
    local = useRef<HTMLInputElement>(null),
    root = useRef<HTMLDivElement>(null),
    nonce = useRef(0),
    ready = useRef<unknown>(null),
    initialRoot = useRef<unknown>(null),
    navigation = useRef<AbortController | null>(null);
  const generation = status?.shared?.generation ?? 0;
  const readOnly = externalReadOnly || Boolean(status?.shared?.changing);
  const reloading = useRef(false),
    replacement = useRef<{ key: string; release(): void } | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const reloadAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    session?.setTransportResolver(resolveWrite);
  }, [session, resolveWrite]);
  useEffect(() => {
    if (client && replacement.current?.key === sessionKey) {
      replacement.current.release();
      replacement.current = null;
    }
  }, [client, sessionKey]);
  useEffect(
    () => () => {
      reloadAbort.current?.abort();
      replacement.current?.release();
      replacement.current = null;
    },
    [],
  );
  const save = useCallback(async () => {
    if (!session || copyOpening.current) return false;
    const copy = session.pendingCopyPath;
    if (!copy && !saveTarget) return false;
    try {
      const receipt = copy
        ? await session.resumeCopy()
        : await session.save(saveTarget!.path, saveTarget!.write);
      if (copy) {
        setCopyNotice(receipt.path);
        setSaveAsPath(null);
        try {
          await onOpenDocument?.(receipt.path);
        } catch (error) {
          setNavigationError(
            error instanceof Error
              ? error.message
              : "The saved file could not be opened.",
          );
        }
      }
      return !client?.getEditSnapshot()?.dirty;
    } catch {
      return false;
    }
  }, [session, saveTarget, client, onOpenDocument]);
  const discard = useCallback(async () => {
    const release = client?.freezeEdits();
    try {
      await discardNbtSession(sessionKey);
      setEpoch((value) => value + 1);
    } finally {
      release?.();
    }
  }, [sessionKey, client]);
  const reload = useCallback(
    async (interpretation?: { profile?: string; compression?: string }) => {
      if (!client || reloading.current)
        throw new Error("NBT reload is already in progress.");
      const shared = nbtSharedDocument(client);
      if (shared) {
        const release = client.freezeEdits();
        reloading.current = true;
        setInterpreting(true);
        try {
          await shared.replace(
            interpretation
              ? {
                  profile: interpretation.profile ?? profile,
                  compression: interpretation.compression ?? compression,
                }
              : undefined,
          );
          if (interpretation?.profile) setProfile(interpretation.profile);
          if (interpretation?.compression)
            setCompression(interpretation.compression);
        } finally {
          release();
          reloading.current = false;
          setInterpreting(false);
        }
        return;
      }
      const release = client.freezeEdits();
      reloading.current = true;
      setInterpreting(true);
      const controller = new AbortController();
      reloadAbort.current = controller;
      const nextProfile = interpretation?.profile ?? profile,
        nextCompression = interpretation?.compression ?? compression,
        nextEpoch = epoch + 1,
        key = JSON.stringify([
          scope + "/reload-" + nextEpoch,
          nextProfile,
          nextCompression,
        ]);
      const lease = acquireNbtSession(
        key,
        (signal) =>
          openNbtViewerClient(
            openSource,
            key,
            nextProfile,
            nextCompression,
            signal,
          ),
        true,
      );
      controller.signal.addEventListener("abort", lease.release, {
        once: true,
      });
      let adopted = false;
      try {
        const next = await lease.promise;
        controller.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          let unsubscribe = () => {};
          const cleanup = () => {
            unsubscribe();
            controller.signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(controller.signal.reason);
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          const check = () => {
            const status = next.client.getSnapshot();
            if (status?.state === "complete") {
              cleanup();
              resolve();
            } else if (
              status?.state === "error" ||
              status?.state === "closed"
            ) {
              cleanup();
              reject(
                new Error(
                  status.error?.message ??
                    "The replacement NBT file could not be read.",
                ),
              );
            }
          };
          unsubscribe = next.client.subscribe(check);
          check();
        });
        controller.signal.throwIfAborted();
        await discardNbtSession(sessionKey);
        controller.signal.throwIfAborted();
        if (openRecovery) {
          const vault = await openRecovery();
          await next.client.attachRecovery({ id: vault.id, key: vault.key });
        }
        replacement.current = { key, release: lease.release };
        adopted = true;
        setProfile(nextProfile);
        setCompression(nextCompression);
        setEpoch(nextEpoch);
      } finally {
        release();
        reloading.current = false;
        setInterpreting(false);
        if (reloadAbort.current === controller) reloadAbort.current = null;
        controller.signal.removeEventListener("abort", lease.release);
        if (!adopted) lease.release();
      }
    },
    [
      client,
      epoch,
      scope,
      profile,
      compression,
      openSource,
      sessionKey,
      openRecovery,
    ],
  );
  const lifecycle = useMemo<FileViewerSession | null>(
    () =>
      client && edit
        ? {
            get revision() {
              return (
                session?.revision ?? client.getEditSnapshot()?.revision ?? 0
              );
            },
            get dirty() {
              return client.getEditSnapshot()?.dirty ?? false;
            },
            get saving() {
              return Boolean(
                client.getEditSnapshot()?.saving ||
                session?.busy ||
                copyOpening.current ||
                reloading.current ||
                client.getSnapshot()?.shared?.changing,
              );
            },
            get pending() {
              const status = client.getEditSnapshot();
              return Boolean(
                status?.pendingSaveId ||
                status?.editing ||
                client.getSnapshot()?.shared?.changing,
              );
            },
            save,
            discard,
            reload,
            ...(nbtSharedDocument(client)
              ? { checkpoint: () => nbtSharedDocument(client)!.checkpoint() }
              : {}),
          }
        : null,
    [
      client,
      edit,
      save,
      discard,
      reload,
      session,
      progress,
      copyPreparing,
      interpreting,
    ],
  );
  useEffect(() => {
    onSessionChange?.(lifecycle);
  }, [lifecycle, onSessionChange]);
  useEffect(() => () => onSessionChange?.(null), [onSessionChange]);
  useEffect(() => {
    if (!edit?.dirty && !edit?.pendingSaveId && !edit?.editing) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [edit?.dirty, edit?.pendingSaveId, edit?.editing]);
  useEffect(() => {
    setExpanded(new Set());
    setSelected(null);
    setTarget(null);
    setMode("tree");
    setAnchor(null);
    setArrayFocus(null);
    setEditRequest(null);
    setCrumbs([]);
    setNavigationError(null);
    setCopyNotice(null);
    setCopyError(null);
    setSaveAsPath(null);
    ready.current = null;
    initialRoot.current = null;
    navigation.current?.abort();
    return () => navigation.current?.abort();
  }, [client, generation]);
  useEffect(() => {
    if (!client || !active) return;
    const controller = new AbortController();
    const refresh = async (
      row: NbtDisplayRow | null,
      set: Dispatch<SetStateAction<NbtDisplayRow | null>>,
    ) => {
      if (!row) return;
      try {
        const next = await client.describe(row.node.id, controller.signal);
        if (!controller.signal.aborted)
          set((current) => (current?.node.id === row.node.id ? next : current));
      } catch {
        if (!controller.signal.aborted) {
          set((current) => (current?.node.id === row.node.id ? null : current));
          if (row === target) setMode("tree");
        }
      }
    };
    void refresh(selected, setSelected);
    void refresh(target, setTarget);
    return () => controller.abort();
  }, [
    client,
    active,
    generation,
    edit?.revision,
    selected?.node.id,
    target?.node.id,
  ]);
  useEffect(() => {
    if (client && status?.root) {
      if (initialRoot.current !== client) {
        initialRoot.current = client;
        setExpanded(new Set([status.root!]));
      }
      if (ready.current !== client) {
        ready.current = client;
        onReady?.();
      }
    }
    if (status?.state === "error")
      onError?.(new Error(status.error?.message ?? "NBT could not be read."));
  }, [client, generation, status?.root, status?.state, onReady, onError]);
  useEffect(() => {
    if (error) onError?.(new Error(error));
  }, [error, onError]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        !active ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        !["f", "s", "z", "y"].includes(event.key.toLowerCase())
      )
        return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.current?.contains(focus))
        return;
      if (
        ["z", "y"].includes(event.key.toLowerCase()) &&
        focus instanceof HTMLElement &&
        focus.closest("input,textarea")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key.toLowerCase() === "s") {
        if (!readOnly) void save();
        return;
      }
      if (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y") {
        if (
          !readOnly &&
          editing &&
          client &&
          !(focus instanceof HTMLElement && focus.closest("input,textarea"))
        )
          void (
            event.shiftKey || event.key.toLowerCase() === "y"
              ? client.redo()
              : client.undo()
          ).catch((reason) =>
            setNavigationError(String(reason.message ?? reason)),
          );
        return;
      }
      setFind(true);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, readOnly, editing, client, save]);
  const select = useCallback((row: NbtDisplayRow) => {
    navigation.current?.abort();
    setSelected(row);
  }, []);
  const reveal = useCallback(
    async (result: NbtSearchResult, signal?: AbortSignal) => {
      if (!client) return;
      navigation.current?.abort();
      const controller = new AbortController();
      navigation.current = controller;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      setNavigationError(null);
      try {
        const path = await client.ancestors(result.nodeId, controller.signal),
          row = await client.describe(result.nodeId, controller.signal);
        controller.signal.throwIfAborted();
        setExpanded((current) => {
          const next = new Set(current);
          for (const part of path.slice(0, -1)) next.add(part.id);
          return next;
        });
        setSelected(row);
        if (result.elementIndex !== undefined) {
          setTarget(row);
          setMode("array");
          setArrayFocus({ index: result.elementIndex, nonce: ++nonce.current });
        } else {
          setMode("tree");
          setAnchor({ id: row.node.id, center: true, nonce: ++nonce.current });
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setNavigationError(String((reason as Error).message ?? reason));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    [client, generation],
  );
  useEffect(() => {
    if (!active) return;
    if (!client || !selected) {
      setCrumbs([]);
      return;
    }
    const controller = new AbortController();
    void client
      .ancestors(selected.node.id, controller.signal)
      .then(async (path) => {
        const visible = path.length > 8 ? [path[0]!, ...path.slice(-7)] : path;
        const rows = [];
        for (const part of visible)
          rows.push(await client.describe(part.id, controller.signal));
        if (!controller.signal.aborted) setCrumbs(rows);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, active, generation, selected?.node.id, edit?.revision]);
  const open = useCallback((row: NbtDisplayRow, next: "array" | "table") => {
    setSelected(row);
    setTarget(row);
    setMode(next);
    setArrayFocus(null);
  }, []);
  const beginEdit = (
    action: NbtEditAction,
    row = selected,
    element?: number,
  ) => {
    if (row && edit && !readOnly)
      setEditRequest({ action, row, element, revision: edit.revision });
  };
  const protectedDraft = Boolean(
    interpreting ||
    status?.shared?.changing ||
    session?.busy ||
    edit?.dirty ||
    edit?.editing ||
    edit?.saving ||
    edit?.pendingSaveId,
  );
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="relative flex h-full min-h-0 min-w-0 flex-col outline-none"
      data-nbt-viewer=""
      data-nbt-binding={scope}
      data-nbt-generation={generation}
      data-nbt-shared-views={status?.shared?.views}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/45 px-3 py-2 text-xs">
        <span className="mr-1 max-w-40 truncate font-medium" title={label}>
          {label}
        </span>
        <label className="flex items-center gap-1 text-muted-foreground">
          Encoding
          <select
            className={nbtControl}
            aria-label="NBT encoding"
            value={profile}
            disabled={protectedDraft}
            onChange={(event) => {
              if (!client) {
                setProfile(event.target.value);
                setEpoch((value) => value + 1);
              } else
                void reload({ profile: event.target.value }).catch((error) =>
                  setNavigationError(
                    error instanceof Error
                      ? error.message
                      : "The NBT encoding could not be opened.",
                  ),
                );
            }}
          >
            {NBT_PROFILES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          Compression
          <select
            className={nbtControl}
            aria-label="NBT compression"
            value={compression}
            disabled={protectedDraft}
            onChange={(event) => {
              if (!client) {
                setCompression(event.target.value);
                setEpoch((value) => value + 1);
              } else
                void reload({ compression: event.target.value }).catch(
                  (error) =>
                    setNavigationError(
                      error instanceof Error
                        ? error.message
                        : "The NBT compression could not be opened.",
                    ),
                );
            }}
          >
            <option value="auto">Automatic</option>
            <option value="none">Raw</option>
            <option value="gzip">Gzip</option>
            <option value="zlib">Zlib</option>
          </select>
        </label>
        <span
          className="ml-auto text-[10px] text-muted-foreground"
          role="status"
          data-nbt-document-state={status?.state ?? "opening"}
        >
          {status
            ? (status.state === "complete"
                ? status.nodes.toLocaleString() + " tags"
                : status.state === "indexing"
                  ? "Indexing… " + status.nodes.toLocaleString() + " tags"
                  : status.state === "paused"
                    ? "Indexing paused"
                    : status.state) +
              " · " +
              (status.availableBytes / 1024 ** 2).toFixed(1) +
              " MiB"
            : "Opening…"}
        </span>
        <button
          className={nbtControl + " inline-flex items-center gap-1"}
          disabled={!client}
          onClick={() => setFind((value) => !value)}
          aria-label="Find in NBT document"
        >
          <Search className="size-3.5" />
          <span>Find</span>
        </button>
        <button
          className={nbtControl}
          disabled={!client || readOnly}
          onClick={() => setEditing((value) => !value)}
          aria-label="Toggle NBT editing"
          aria-pressed={editing}
        >
          {editing ? "Edit mode" : "View mode"}
        </button>
        {saveTarget ? (
          <button
            className={nbtControl}
            disabled={
              !edit ||
              edit.saving ||
              readOnly ||
              (!edit.dirty && !edit.pendingSaveId)
            }
            onClick={() => void save()}
          >
            {edit?.saving
              ? "Saving…"
              : edit?.pendingSaveId
                ? "Retry save"
                : "Save"}
          </button>
        ) : null}
        {saveAsTarget ? (
          <button
            className={nbtControl}
            disabled={
              !client || readOnly || Boolean(session?.busy) || copyPreparing
            }
            onClick={() => {
              setSaveAsPath(
                saveAsPath ??
                  session?.pendingCopyPath ??
                  (saveTarget?.path ?? label) + ".copy.nbt",
              );
              setCopyError(null);
            }}
          >
            Save As…
          </button>
        ) : null}
        <span
          className="text-[10px] text-muted-foreground"
          data-nbt-dirty={edit?.dirty ? "true" : "false"}
        >
          {progress?.phase === "uploading"
            ? "Uploading " + (progress.uploaded / 1024 ** 2).toFixed(1) + " MiB"
            : progress?.phase === "committing"
              ? "Committing…"
              : edit?.uncertain
                ? "Save needs reconciliation"
                : edit?.dirty
                  ? "Unsaved changes"
                  : progress?.phase === "saved"
                    ? "Saved"
                    : ""}
        </span>
        {onLocalFile ? (
          <>
            <input
              ref={local}
              type="file"
              accept=".nbt,.dat,.dat_old,.schematic,.litematic,.structure,*/*"
              className="hidden"
              aria-label="Choose local NBT file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file && !protectedDraft) onLocalFile(file);
                event.target.value = "";
              }}
            />
            <button
              className={nbtControl}
              disabled={protectedDraft}
              onClick={() => local.current?.click()}
              aria-label="Open local NBT file"
            >
              <FileUp className="size-3.5" />
            </button>
          </>
        ) : null}
      </div>
      {saveAsPath !== null && saveAsTarget && session ? (
        <form
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/30 p-3 text-xs"
          aria-label="Save NBT As"
          onSubmit={(event) => {
            event.preventDefault();
            if (copyOpening.current) return;
            copyOpening.current = true;
            setCopyPreparing(true);
            setCopyError(null);
            void (async () => {
              const write = await saveAsTarget(saveAsPath);
              await session.saveAs(saveAsPath, write);
              setCopyNotice(saveAsPath);
              setSaveAsPath(null);
              try {
                await onOpenDocument?.(saveAsPath);
              } catch (error) {
                setNavigationError(
                  error instanceof Error
                    ? error.message
                    : "The saved file could not be opened.",
                );
              }
            })()
              .catch((error) =>
                setCopyError(
                  error instanceof Error ? error.message : "Save As failed.",
                ),
              )
              .finally(() => {
                copyOpening.current = false;
                setCopyPreparing(false);
              });
          }}
        >
          <label className="flex min-w-0 flex-1 items-center gap-2">
            Project path
            <input
              autoFocus
              className={nbtControl + " min-w-0 flex-1"}
              aria-label="NBT Save As path"
              value={saveAsPath}
              disabled={Boolean(session.busy) || copyPreparing}
              onChange={(event) => setSaveAsPath(event.target.value)}
            />
          </label>
          <button
            className={nbtControl}
            disabled={
              !saveAsPath || Boolean(session.busy) || copyPreparing || readOnly
            }
            type="submit"
          >
            Save new file
          </button>
          <button
            type="button"
            className={nbtControl}
            disabled={Boolean(session.busy) || copyPreparing}
            onClick={() => setSaveAsPath(null)}
          >
            Cancel
          </button>
          <p className="w-full text-muted-foreground">
            Creates a new file. The draft in this original tab is retained.
          </p>
          {copyError ? (
            <p role="alert" className="w-full text-destructive">
              {copyError}
            </p>
          ) : null}
        </form>
      ) : null}
      {copyNotice ? (
        <p
          role="status"
          className="shrink-0 border-b border-border/30 px-3 py-2 text-xs text-muted-foreground"
        >
          Saved to {copyNotice}. This original tab still retains its draft.
        </p>
      ) : null}
      {editing && client ? (
        <NbtEditActions
          client={client}
          edit={edit}
          selected={selected}
          readOnly={readOnly}
          onEdit={beginEdit}
          onError={setNavigationError}
        />
      ) : null}
      <div
        className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/25 px-2 text-[10px] text-muted-foreground"
        aria-label="NBT breadcrumbs"
      >
        {mode !== "tree" ? (
          <button
            className="mr-1 inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 hover:bg-accent"
            onClick={() => {
              setMode("tree");
              if (target)
                setAnchor({
                  id: target.node.id,
                  center: false,
                  nonce: ++nonce.current,
                });
            }}
          >
            <ArrowLeft className="size-3" />
            Tree
          </button>
        ) : null}
        {crumbs.length ? (
          crumbs.map((row, i) => (
            <span
              className="inline-flex shrink-0 items-center"
              key={row.node.id}
            >
              {i ? <span className="mx-1 opacity-40">›</span> : null}
              <button
                className="max-w-36 truncate rounded px-1 py-1 hover:bg-accent"
                onClick={() =>
                  void reveal({
                    id: "breadcrumb",
                    nodeId: row.node.id,
                    fields: [],
                  })
                }
              >
                {row.name ||
                  (row.node.parent === null
                    ? "Root"
                    : "[" + row.node.ordinal + "]")}
              </button>
            </span>
          ))
        ) : (
          <span>Names / types / values</span>
        )}
        {selected ? (
          <span className="ml-auto shrink-0 pl-2">
            {NBT_TYPE_NAMES[selected.node.type]}
          </span>
        ) : null}
      </div>
      {error || navigationError || status?.error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {error ?? navigationError ?? status?.error?.message}
          <p className="mt-1 text-muted-foreground">
            Check the encoding and compression options for this file.
          </p>
        </div>
      ) : null}
      {progress?.error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/30 p-3 text-xs text-destructive"
        >
          {progress.error}
          <p className="mt-1 text-muted-foreground">
            Your draft is retained.{" "}
            {progress.phase === "conflict"
              ? "Reload to discard the draft or save it to another file."
              : "Retry save to resume the upload and reconcile its receipt."}
          </p>
          <button
            className={nbtControl + " mt-2"}
            disabled={edit?.saving || readOnly}
            onClick={() => void save()}
          >
            Retry save
          </button>
          <button
            className={nbtControl + " ml-2"}
            disabled={edit?.saving || readOnly || Boolean(session?.busy)}
            onClick={() =>
              void (async () => {
                if (
                  await confirmEditorAction(
                    "Reload this NBT file and discard its unsaved changes?",
                  )
                )
                  await reload();
              })().catch((error) =>
                setNavigationError(
                  error instanceof Error ? error.message : "NBT reload failed.",
                ),
              )
            }
          >
            Reload from disk
          </button>
        </div>
      ) : null}
      {client ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {mode === "array" && target ? (
            <NbtArray
              key={generation + "/" + target.node.id}
              active={active}
              client={client}
              row={target}
              focus={arrayFocus}
              availableBytes={status?.availableBytes ?? 0}
              revision={edit?.revision ?? 0}
              onEdit={
                editing && !readOnly
                  ? (element) => beginEdit("array", target, element)
                  : undefined
              }
            />
          ) : mode === "table" && target ? (
            <NbtTable
              key={generation + "/" + target.node.id}
              active={active}
              client={client}
              row={target}
              nodes={status?.nodes ?? 0}
              revision={edit?.revision ?? 0}
              onSelect={select}
            />
          ) : (
            <NbtTree
              key={"tree/" + generation}
              active={active}
              client={client}
              root={status?.root ?? null}
              nodes={status?.nodes ?? 0}
              revision={edit?.revision ?? 0}
              expanded={expanded}
              onExpanded={setExpanded}
              selected={selected?.node.id ?? null}
              onSelected={select}
              onOpen={open}
              anchor={anchor}
            />
          )}
          <NbtFind
            key={"find/" + generation}
            client={client}
            active={active}
            revision={edit?.revision ?? 0}
            open={find}
            onClose={() => {
              setFind(false);
              root.current
                ?.querySelector<HTMLElement>('[role="treegrid"]')
                ?.focus();
            }}
            inputRef={input}
            selection={
              selected
                ? { id: selected.node.id, name: selected.name || "Root" }
                : status?.root
                  ? { id: status.root, name: "Root" }
                  : null
            }
            onReveal={reveal}
          />
          {editRequest ? (
            <NbtEditSheet
              key={
                editRequest.action +
                editRequest.row.node.id +
                editRequest.revision +
                String(editRequest.element)
              }
              client={client}
              request={editRequest}
              readOnly={readOnly}
              onClose={() => setEditRequest(null)}
              onApplied={(id) =>
                void reveal({ id: "edit", nodeId: id, fields: [] })
              }
            />
          ) : null}
        </div>
      ) : !error ? (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">
          Opening NBT document…
        </div>
      ) : null}
    </div>
  );
}
