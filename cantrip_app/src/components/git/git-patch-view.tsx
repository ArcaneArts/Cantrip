import { ArrowLeft, FileDiff, Loader2, X } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { parseSideBySideDiff } from "./git-diff";

export function GitPatchView({
  error,
  loading,
  newLabel,
  oldLabel,
  onClose,
  onCommentLine,
  originalPath,
  patch,
  path,
  showClose = true,
  subtitle,
  truncated,
}: {
  error: unknown;
  loading: boolean;
  newLabel: string;
  oldLabel: string;
  onClose(): void;
  onCommentLine?(line: number, side: "LEFT" | "RIGHT"): void;
  originalPath?: string | null;
  patch: string | undefined;
  path: string;
  showClose?: boolean;
  subtitle: string;
  truncated: boolean;
}) {
  const rows = useMemo(() => parseSideBySideDiff(patch ?? ""), [patch]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 md:hidden"
          onClick={onClose}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back to changed files</span>
        </Button>
        <FileDiff className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium" title={path}>
            {path}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {originalPath ? `${originalPath} → ${path} · ` : ""}
            {subtitle}
          </p>
        </div>
        {showClose ? (
          <Button
            size="icon"
            variant="ghost"
            className="hidden size-8 md:inline-flex"
            onClick={onClose}
            title="Close diff"
          >
            <X className="size-4" />
            <span className="sr-only">Close diff</span>
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading diff…
          </div>
        </div>
      ) : error ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-destructive">
          {error instanceof Error ? error.message : "Diff could not be loaded."}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
          {truncated ? (
            <div className="sticky left-0 top-0 z-10 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              This diff is very large, so only the first portion is shown.
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="grid min-h-48 place-items-center p-6 text-center text-sm text-muted-foreground">
              No textual line changes to display.
            </div>
          ) : (
            <div className="min-w-[720px] font-mono text-[11px] leading-5">
              <div
                data-slot="table-header-surface"
                className="sticky top-0 z-[1] grid grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)] border-b bg-muted/90 text-[10px] font-semibold text-muted-foreground backdrop-blur"
              >
                <span className="px-2 text-right">Old</span>
                <span className="border-l px-2">{oldLabel}</span>
                <span className="border-l px-2 text-right">New</span>
                <span className="border-l px-2">{newLabel}</span>
              </div>
              {rows.map((row, index) => {
                if (row.kind !== "line") {
                  return (
                    <div
                      key={`${row.kind}:${index}`}
                      className={cn(
                        "border-b px-3 py-1 whitespace-pre-wrap",
                        row.kind === "hunk"
                          ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                          : "bg-muted/40 text-muted-foreground",
                      )}
                    >
                      {row.text}
                    </div>
                  );
                }
                return (
                  <div
                    key={`line:${index}`}
                    className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)]"
                  >
                    <button
                      type="button"
                      disabled={!onCommentLine || row.oldNumber === null}
                      title={
                        onCommentLine && row.oldNumber !== null
                          ? `Comment on old line ${row.oldNumber}`
                          : undefined
                      }
                      onClick={() => {
                        if (row.oldNumber !== null) {
                          onCommentLine?.(row.oldNumber, "LEFT");
                        }
                      }}
                      className={cn(
                        "select-none border-b px-2 text-right text-muted-foreground/70",
                        onCommentLine &&
                          row.oldNumber !== null &&
                          "cursor-pointer hover:bg-blue-500/20 hover:text-foreground",
                        row.oldKind === "delete" && "bg-red-500/15",
                        row.oldKind === "empty" && "bg-muted/30",
                      )}
                    >
                      {row.oldNumber}
                    </button>
                    <pre
                      className={cn(
                        "overflow-hidden border-b border-l px-2 whitespace-pre [tab-size:4]",
                        row.oldKind === "delete" &&
                          "bg-red-500/15 text-red-950 dark:text-red-100",
                        row.oldKind === "empty" &&
                          "bg-[repeating-linear-gradient(-45deg,transparent,transparent_4px,var(--color-muted)_4px,var(--color-muted)_5px)]",
                      )}
                    >
                      {row.oldText ?? " "}
                    </pre>
                    <button
                      type="button"
                      disabled={!onCommentLine || row.newNumber === null}
                      title={
                        onCommentLine && row.newNumber !== null
                          ? `Comment on new line ${row.newNumber}`
                          : undefined
                      }
                      onClick={() => {
                        if (row.newNumber !== null) {
                          onCommentLine?.(row.newNumber, "RIGHT");
                        }
                      }}
                      className={cn(
                        "select-none border-b border-l px-2 text-right text-muted-foreground/70",
                        onCommentLine &&
                          row.newNumber !== null &&
                          "cursor-pointer hover:bg-blue-500/20 hover:text-foreground",
                        row.newKind === "add" && "bg-emerald-500/15",
                        row.newKind === "empty" && "bg-muted/30",
                      )}
                    >
                      {row.newNumber}
                    </button>
                    <pre
                      className={cn(
                        "overflow-hidden border-b border-l px-2 whitespace-pre [tab-size:4]",
                        row.newKind === "add" &&
                          "bg-emerald-500/15 text-emerald-950 dark:text-emerald-100",
                        row.newKind === "empty" &&
                          "bg-[repeating-linear-gradient(-45deg,transparent,transparent_4px,var(--color-muted)_4px,var(--color-muted)_5px)]",
                      )}
                    >
                      {row.newText ?? " "}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
