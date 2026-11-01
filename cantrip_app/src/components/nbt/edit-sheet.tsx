import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { NbtTag } from "@cantrip/nbt";
import type {
  NbtDisplayRow,
  NbtDocumentClient,
  NbtEditOperation,
  NbtEditValue,
} from "@cantrip/nbt/document";
import {
  container,
  numericArray,
  nbtControl,
  nbtScalarText,
  NBT_TYPE_NAMES,
} from "./format";

export type NbtEditAction =
  "value" | "rename" | "insert" | "duplicate" | "delete" | "replace" | "array";
export interface NbtEditRequest {
  action: NbtEditAction;
  row: NbtDisplayRow;
  element?: number;
  revision: number;
}
const TYPES = Array.from({ length: 12 }, (_, i) => (i + 1) as NbtTag);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "NBT edit failed.";
const batch = (text: string) => {
  const values = text.trim() ? text.trim().split(/[\s,]+/u) : [];
  if (values.length > 4096)
    throw new Error("Paste up to 4,096 values in one transaction.");
  return values;
};
function newValue(
  type: NbtTag,
  text: string,
  elementType: NbtTag,
): NbtEditValue {
  return type === NbtTag.Compound
    ? { type, children: [] }
    : type === NbtTag.List
      ? { type, elementType, items: [] }
      : numericArray({ type })
        ? { type, values: batch(text) }
        : { type, value: text };
}
export function NbtEditSheet({
  client,
  request,
  readOnly,
  onClose,
  onApplied,
}: {
  client: NbtDocumentClient;
  request: NbtEditRequest;
  readOnly: boolean;
  onClose(): void;
  onApplied(id: string): void;
}) {
  const { action, row, revision } = request;
  const [type, setType] = useState<NbtTag>(
      action === "insert"
        ? row.node.elementType || NbtTag.String
        : row.node.type,
    ),
    [elementType, setElementType] = useState<NbtTag>(NbtTag.Compound),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [index, setIndex] = useState(
      String(
        request.element ??
          (action === "insert" ? row.node.childCount : row.node.ordinal + 1),
      ),
    ),
    [remove, setRemove] = useState(request.element === undefined ? "0" : "1"),
    [page, setPage] = useState<{
      offset: number;
      nextOffset: number;
      totalBytes: number;
      text: string;
    } | null>(null),
    [offsets, setOffsets] = useState([0]),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null),
    form = useRef<HTMLFormElement>(null);
  const stringPage = action === "value" && row.node.type === NbtTag.String;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoaded(false);
    setError(null);
    void (async () => {
      if (action === "rename" || action === "duplicate") {
        if (row.node.name) {
          const result = await client.textPage(
            row.node.id,
            "name",
            0,
            65535,
            controller.signal,
          );
          if (result.truncated) {
            setName("");
            setNotice(
              "The existing name is large. Enter its complete replacement name.",
            );
          } else setName(result.text + (action === "duplicate" ? " copy" : ""));
        }
      } else if (stringPage) {
        const result = await client.textPage(
          row.node.id,
          "value",
          offsets.at(-1)!,
          4096,
          controller.signal,
        );
        setPage(result);
        setText(result.text);
      } else if (action === "array" && request.element !== undefined) {
        const [value] = await client.array(
          row.node.id,
          request.element,
          1,
          controller.signal,
        );
        setText(String(value));
      } else if (action === "value") setText(nbtScalarText(row.value ?? ""));
      else setText(type === NbtTag.String ? "" : "0");
      controller.signal.throwIfAborted();
      setLoading(false);
      setLoaded(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    })().catch((reason) => {
      if (!controller.signal.aborted) {
        setError(message(reason));
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [client, request, stringPage, offsets]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const isContainer = container({ type }),
    isArray = numericArray({ type });
  const inputClass = nbtControl + " w-full";
  const submit = async () => {
    if (busy || loading || !loaded || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const position = Number(index),
        count = Number(remove);
      let operation: NbtEditOperation;
      if (action === "delete") operation = { type: "delete", id: row.node.id };
      else if (action === "rename")
        operation = { type: "rename", id: row.node.id, name };
      else if (action === "duplicate")
        operation = {
          type: "duplicate",
          id: row.node.id,
          parent: row.node.parent!,
          index: position,
          ...(row.node.name ? { name } : {}),
        };
      else if (action === "insert")
        operation = {
          type: "insert",
          parent: row.node.id,
          index: position,
          ...(row.node.type === NbtTag.Compound ? { name } : {}),
          value: newValue(type, text, elementType),
        };
      else if (action === "replace")
        operation = {
          type: "replace",
          id: row.node.id,
          value: newValue(type, text, elementType),
        };
      else if (action === "array")
        operation = {
          type: "array.splice",
          id: row.node.id,
          index: position,
          remove: count,
          values: batch(text),
        };
      else if (stringPage && page)
        operation = {
          type: "string.splice",
          id: row.node.id,
          offset: page.offset,
          remove: page.nextOffset - page.offset,
          text,
        };
      else operation = { type: "value", id: row.node.id, value: text };
      const result = await client.edit(
        [operation],
        revision,
        action === "replace" ? "Change NBT tag type" : "Edit NBT " + action,
      );
      onApplied(result.selection);
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const title =
    action === "insert"
      ? "Add NBT tag"
      : action === "replace"
        ? "Change tag type"
        : action === "array"
          ? "Edit array range"
          : action === "delete"
            ? "Delete subtree"
            : action === "duplicate"
              ? "Duplicate subtree"
              : action === "rename"
                ? "Rename property"
                : "Edit value";
  return (
    <div
      className="absolute inset-0 z-30 flex items-end justify-end bg-background/35 sm:items-start"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="m-2 flex max-h-[calc(100%-1rem)] w-[min(29rem,calc(100%-1rem))] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-4 text-xs shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const elements = [
              ...(form.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
              ) ?? []),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">{title}</h3>
          <button
            type="button"
            className="rounded p-2 hover:bg-accent"
            aria-label="Close NBT edit"
            disabled={busy}
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="truncate text-muted-foreground">
          {row.name || "[" + row.node.ordinal + "]"} ·{" "}
          {NBT_TYPE_NAMES[row.node.type]}
        </p>
        {notice ? (
          <p role="status" className="text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {action === "delete" ? (
          <p>Delete this tag and its descendants? You can undo this change.</p>
        ) : null}
        {action === "replace" ? (
          <p className="text-muted-foreground">
            This replaces the current value and descendants. The name and
            identity are preserved. Undo restores the original subtree.
          </p>
        ) : null}
        {action === "rename" ||
        (action === "duplicate" && row.node.name) ||
        (action === "insert" && row.node.type === NbtTag.Compound) ? (
          <label className="grid gap-1">
            Name
            <input
              ref={(node) => {
                input.current = node;
              }}
              aria-label="NBT property name"
              className={inputClass}
              value={name}
              disabled={loading || !loaded || busy || readOnly}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}
        {action === "insert" || action === "replace" ? (
          <label className="grid gap-1">
            Type
            <select
              aria-label="New NBT tag type"
              className={inputClass}
              value={type}
              disabled={
                busy ||
                readOnly ||
                (action === "insert" &&
                  row.node.type === NbtTag.List &&
                  row.node.elementType !== NbtTag.End)
              }
              onChange={(event) => {
                setType(Number(event.target.value));
                setText(
                  Number(event.target.value) === NbtTag.String ? "" : "0",
                );
              }}
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {NBT_TYPE_NAMES[type]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {action === "insert" || action === "duplicate" || action === "array" ? (
          <label className="grid gap-1">
            {action === "array" ? "Start index" : "Insert at index"}
            <input
              aria-label="NBT edit index"
              className={inputClass}
              inputMode="numeric"
              value={index}
              disabled={busy || readOnly}
              onChange={(event) => setIndex(event.target.value)}
            />
          </label>
        ) : null}
        {action === "array" ? (
          <label className="grid gap-1">
            Remove elements
            <input
              aria-label="NBT remove count"
              className={inputClass}
              inputMode="numeric"
              value={remove}
              disabled={busy || readOnly}
              onChange={(event) => setRemove(event.target.value)}
            />
          </label>
        ) : null}
        {(action === "insert" || action === "replace") &&
        type === NbtTag.List ? (
          <label className="grid gap-1">
            List element type
            <select
              className={inputClass}
              aria-label="NBT list element type"
              value={elementType}
              disabled={busy || readOnly}
              onChange={(event) => setElementType(Number(event.target.value))}
            >
              {[NbtTag.End, ...TYPES].map((value) => (
                <option key={value} value={value}>
                  {value === NbtTag.End
                    ? "Unspecified (empty list)"
                    : NBT_TYPE_NAMES[value]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {action === "value" ||
        action === "array" ||
        ((action === "insert" || action === "replace") && !isContainer) ? (
          <label className="grid gap-1">
            {isArray || action === "array"
              ? "Values (comma or whitespace separated)"
              : "Value"}
            <textarea
              ref={(node) => {
                input.current = node;
              }}
              aria-label="NBT edit value"
              spellCheck={false}
              className="min-h-28 w-full rounded border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
              maxLength={isArray || action === "array" ? 200000 : 65535}
              value={text}
              disabled={loading || busy || readOnly}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        ) : null}
        {(action === "insert" || action === "replace") && isContainer ? (
          <p className="text-muted-foreground">
            Creates an empty {NBT_TYPE_NAMES[type]}. Add its entries from the
            tree.
          </p>
        ) : null}
        {isArray || action === "array" ? (
          <p className="text-muted-foreground">
            Up to 4,096 values per transaction. Leave values empty to remove a
            range.
          </p>
        ) : null}
        {stringPage && page ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>
              Bytes {page.offset.toLocaleString()}–
              {page.nextOffset.toLocaleString()} of{" "}
              {page.totalBytes.toLocaleString()}
            </span>
            <button
              type="button"
              className={nbtControl}
              disabled={
                offsets.length === 1 || text !== page.text || busy || loading
              }
              onClick={() => setOffsets((items) => items.slice(0, -1))}
            >
              Previous page
            </button>
            <button
              type="button"
              className={nbtControl}
              disabled={
                page.nextOffset === page.totalBytes ||
                text !== page.text ||
                busy ||
                loading
              }
              onClick={() => setOffsets((items) => [...items, page.nextOffset])}
            >
              Next page
            </button>
            <span>Apply this page before navigating to another.</span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={nbtControl}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={nbtControl}
            disabled={loading || !loaded || busy || readOnly}
          >
            {busy ? "Applying…" : action === "delete" ? "Delete" : "Apply"}
          </button>
        </div>
      </form>
    </div>
  );
}
