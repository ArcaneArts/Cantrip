import { ArrowLeft, FileDiff, Loader2, X } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { parseUnifiedDiff } from "./git-diff";

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
  const rows = useMemo(() => parseUnifiedDiff(patch ?? ""), [patch]);

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
        <div className="min-h-0 flex-1 overflow-auto">
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
            <div
              aria-label={`${oldLabel} to ${newLabel}`}
              className="w-max min-w-full py-1 font-mono text-[11px] leading-5"
            >
              {rows.map((row, index) => {
                if (row.kind !== "line") {
                  return (
                    <div
                      key={`${row.kind}:${index}`}
                      className={cn(
                        "px-3 py-1 whitespace-pre-wrap",
                        row.kind === "hunk"
                          ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                          : "text-muted-foreground",
                      )}
                    >
                      {row.text}
                    </div>
                  );
                }
                return (
                  <div
                    key={`line:${index}`}
                    className={cn(
                      "grid min-h-5",
                      onCommentLine
                        ? "grid-cols-[2.75rem_2.75rem_1rem_minmax(max-content,1fr)]"
                        : "grid-cols-[1rem_minmax(max-content,1fr)]",
                      row.lineKind === "delete" &&
                        "bg-red-500/10 text-red-950 dark:text-red-100",
                      row.lineKind === "add" &&
                        "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
                    )}
                  >
                    {onCommentLine ? (
                      <>
                        <button
                          type="button"
                          disabled={row.oldNumber === null}
                          title={
                            row.oldNumber !== null
                              ? `Comment on old line ${row.oldNumber}`
                              : undefined
                          }
                          onClick={() => {
                            if (row.oldNumber !== null) {
                              onCommentLine(row.oldNumber, "LEFT");
                            }
                          }}
                          className={cn(
                            "select-none px-1 text-right text-muted-foreground/60",
                            row.oldNumber !== null &&
                              "cursor-pointer hover:bg-blue-500/20 hover:text-foreground",
                          )}
                        >
                          {row.oldNumber}
                        </button>
                        <button
                          type="button"
                          disabled={row.newNumber === null}
                          title={
                            row.newNumber !== null
                              ? `Comment on new line ${row.newNumber}`
                              : undefined
                          }
                          onClick={() => {
                            if (row.newNumber !== null) {
                              onCommentLine(row.newNumber, "RIGHT");
                            }
                          }}
                          className={cn(
                            "select-none px-1 text-right text-muted-foreground/60",
                            row.newNumber !== null &&
                              "cursor-pointer hover:bg-blue-500/20 hover:text-foreground",
                          )}
                        >
                          {row.newNumber}
                        </button>
                      </>
                    ) : null}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "select-none text-center",
                        row.lineKind === "delete" && "text-red-500",
                        row.lineKind === "add" && "text-emerald-500",
                        row.lineKind === "context" &&
                          "text-muted-foreground/40",
                      )}
                    >
                      {row.lineKind === "delete"
                        ? "-"
                        : row.lineKind === "add"
                          ? "+"
                          : " "}
                    </span>
                    <pre className="overflow-hidden pr-4 whitespace-pre [tab-size:4]">
                      {row.text || " "}
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
