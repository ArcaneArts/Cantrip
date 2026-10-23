import { explorerEntryNameSchema, type ExplorerEntry } from "@cantrip/protocol";
import { File, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExplorerFileMutationAuthorization } from "./project-sidebar-file-tree";

export interface SidebarNewFileDraft {
  parentPath: string;
  value: string;
  error: string | null;
  pending: boolean;
  onChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}

export function useSidebarNewFile({
  explorerId,
  bindingKey,
  authorize,
  onCreate,
}: {
  explorerId: string | undefined;
  bindingKey: string | null;
  authorize(): ExplorerFileMutationAuthorization | null;
  onCreate(
    parentPath: string,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
}) {
  const [draft, setDraft] = useState<{
    parentPath: string;
    value: string;
    error: string | null;
    authorization: ExplorerFileMutationAuthorization;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  useEffect(() => setDraft(null), [explorerId, bindingKey]);
  const cancel = () => {
    if (!submitting.current) setDraft(null);
  };
  const submit = () => {
    if (!draft || submitting.current || !draft.authorization.isCurrent())
      return;
    const parsed = explorerEntryNameSchema.safeParse(draft.value);
    if (!parsed.success) {
      setDraft({
        ...draft,
        error: parsed.error.issues[0]?.message ?? "Enter a valid file name.",
      });
      return;
    }
    submitting.current = true;
    setPending(true);
    setDraft({ ...draft, error: null });
    void onCreate(draft.parentPath, parsed.data, draft.authorization)
      .then(() => {
        if (draft.authorization.isCurrent()) setDraft(null);
      })
      .catch((error: unknown) => {
        if (!draft.authorization.isCurrent()) return;
        setDraft({
          ...draft,
          error:
            error instanceof Error
              ? error.message
              : "The file could not be created.",
        });
      })
      .finally(() => {
        submitting.current = false;
        setPending(false);
      });
  };
  return {
    pending,
    cancel,
    begin(parentPath: string) {
      if (submitting.current) return false;
      const authorization = authorize();
      if (!authorization) return false;
      setDraft({ parentPath, value: "", error: null, authorization });
      return true;
    },
    draft: draft
      ? ({
          parentPath: draft.parentPath,
          value: draft.value,
          error: draft.error,
          pending,
          onChange: (value: string) =>
            setDraft({ ...draft, value, error: null }),
          onCancel: cancel,
          onSubmit: submit,
        } satisfies SidebarNewFileDraft)
      : null,
  };
}

export function SidebarNewFileRow({
  depth,
  draft,
}: {
  depth: number;
  draft: SidebarNewFileDraft;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!draft.pending) input.current?.focus();
  }, [draft.pending]);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-busy={draft.pending}
      data-elite-ignore=""
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        className="flex h-7 min-w-0 items-center gap-1 px-1"
        style={{ paddingLeft: `${4 + depth * 6}px` }}
      >
        <span className="size-3 shrink-0" aria-hidden="true" />
        <File className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          aria-label="New file name"
          aria-invalid={Boolean(draft.error)}
          className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          placeholder="filename.ext"
          disabled={draft.pending}
          value={draft.value}
          onChange={(event) => draft.onChange(event.target.value)}
          onBlur={draft.onCancel}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              draft.onSubmit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              draft.onCancel();
            }
          }}
        />
        {draft.pending ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : null}
      </div>
      {draft.error ? (
        <p role="alert" className="px-2 pb-1 text-[10px] text-destructive">
          {draft.error}
        </p>
      ) : null}
    </div>
  );
}
