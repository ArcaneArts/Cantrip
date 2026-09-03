import type { GitDiffFileSide } from "@cantrip/protocol";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Binary,
  Check,
  CheckSquare2,
  Columns2,
  Copy,
  FileDiff,
  FolderOpen,
  ImageIcon,
  Loader2,
  MessageSquare,
  Pilcrow,
  Rows3,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SyntaxHighlightedCode } from "@/components/chat/markdown-code";
import { Button } from "@/components/ui/button";
import { monacoLanguageForPath } from "@/components/explorer/explorer-file-language";
import { openExternalUrl } from "@/lib/external-url";
import { cn } from "@/lib/utils";

import {
  buildSplitDiffRows,
  hideWhitespaceOnlyChanges,
  parseRichUnifiedDiff,
  type RichDiffLine,
  type RichDiffRow,
} from "./git-diff";

export interface GitDiffCommentTarget {
  line: number;
  side: "LEFT" | "RIGHT";
}

export interface GitDiffCommentSelection extends GitDiffCommentTarget {
  selectedText: string;
  startLine: number | null;
  startSide: "LEFT" | "RIGHT" | null;
}

export interface GitDiffLineSelection {
  selected: ReadonlySet<string>;
  onToggleHunk(hunkIndex: number, lineIndexes: number[]): void;
  onToggleLine(hunkIndex: number, lineIndex: number): void;
}

export type GitDiffFilePreview = GitDiffFileSide & { url?: string };

export function gitDiffImagePreviewFromUrl(
  path: string,
  url: string | null,
): GitDiffFilePreview | undefined {
  if (!url) return undefined;
  const extension = path.split(".").at(-1)?.toLowerCase();
  const mimeType =
    extension === "png" || extension === "apng"
      ? `image/${extension}`
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "gif"
          ? "image/gif"
          : extension === "webp"
            ? "image/webp"
            : extension === "avif"
              ? "image/avif"
              : extension === "bmp"
                ? "image/bmp"
                : extension === "ico"
                  ? "image/x-icon"
                  : null;
  return mimeType
    ? {
        kind: "image",
        size: null,
        mimeType,
        base64: null,
        truncated: false,
        url,
      }
    : undefined;
}

function languageClassName(path: string): string | undefined {
  const language = monacoLanguageForPath(path);
  if (!language || language === "plaintext") return undefined;
  const aliases: Record<string, string> = {
    bat: "bash",
    dockerfile: "bash",
    handlebars: "markup",
    html: "markup",
    javascriptreact: "jsx",
    mdx: "markdown",
    "objective-c": "c",
    powershell: "bash",
    shellscript: "bash",
    typescriptreact: "tsx",
    xml: "markup",
  };
  return `language-${aliases[language] ?? language}`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function imageSource(file: GitDiffFilePreview): string | null {
  if (file.url) return file.url;
  return file.base64 && file.mimeType
    ? `data:${file.mimeType};base64,${file.base64}`
    : null;
}

function DiffFileCard({
  file,
  label,
}: {
  file: GitDiffFilePreview | undefined;
  label: string;
}) {
  if (!file || file.kind === "missing") {
    return (
      <div className="grid min-h-56 place-items-center rounded-lg border border-dashed bg-muted/15 p-6 text-center">
        <div>
          <FileDiff className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 text-xs font-medium">{label}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {file
              ? "File does not exist on this side."
              : "A preview is unavailable for this side."}
          </p>
        </div>
      </div>
    );
  }
  const source = file.kind === "image" ? imageSource(file) : null;
  return (
    <div className="flex min-h-56 min-w-0 flex-col overflow-hidden rounded-lg border bg-[image:linear-gradient(45deg,hsl(var(--muted)/.35)_25%,transparent_25%),linear-gradient(-45deg,hsl(var(--muted)/.35)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,hsl(var(--muted)/.35)_75%),linear-gradient(-45deg,transparent_75%,hsl(var(--muted)/.35)_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-background/95 px-3 text-xs backdrop-blur">
        {file.kind === "image" ? (
          <ImageIcon className="size-3.5" />
        ) : (
          <Binary className="size-3.5" />
        )}
        <span className="font-medium">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatBytes(file.size)}
        </span>
      </div>
      {source ? (
        <div className="grid min-h-48 flex-1 place-items-center overflow-auto p-4">
          <img
            alt={`${label} image preview`}
            className="max-h-[65vh] max-w-full object-contain"
            src={source}
          />
        </div>
      ) : (
        <div className="grid min-h-48 flex-1 place-items-center bg-background/80 p-6 text-center text-xs text-muted-foreground">
          <div>
            <Binary className="mx-auto size-7" />
            <p className="mt-3">
              {file.kind === "image" && file.truncated
                ? "Image exceeds the 2 MB inline preview limit."
                : "Binary content cannot be displayed as text."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function LineText({ line, path }: { line: RichDiffLine; path: string }) {
  if (line.wordSegments?.some(({ changed }) => changed)) {
    return (
      <code className="block min-w-max font-mono text-[11px] leading-5">
        {line.wordSegments.map((segment, index) => (
          <span
            className={cn(
              segment.changed &&
                (line.lineKind === "delete"
                  ? "rounded-sm bg-red-500/30"
                  : "rounded-sm bg-emerald-500/30"),
            )}
            key={index}
          >
            {segment.text}
          </span>
        ))}
      </code>
    );
  }
  return (
    <SyntaxHighlightedCode
      className={languageClassName(path)}
      children={line.text || " "}
    />
  );
}

function lineNumber(line: RichDiffLine, side: "LEFT" | "RIGHT") {
  return side === "LEFT" ? line.oldNumber : line.newNumber;
}

function lineSelected(
  line: RichDiffLine,
  side: "LEFT" | "RIGHT",
  selection: {
    anchor: GitDiffCommentTarget;
    focus: GitDiffCommentTarget;
  } | null,
) {
  const number = lineNumber(line, side);
  if (
    number === null ||
    !selection ||
    selection.anchor.side !== side ||
    selection.focus.side !== side
  ) {
    return false;
  }
  const start = Math.min(selection.anchor.line, selection.focus.line);
  const end = Math.max(selection.anchor.line, selection.focus.line);
  return number >= start && number <= end;
}

function selectionKey(line: RichDiffLine): string {
  return `${line.hunkIndex}:${line.lineIndex}`;
}

function nextContextLines(current: number): number {
  if (current < 20) return 20;
  if (current < 100) return 100;
  return 1_000;
}

export function GitPatchView({
  binary = false,
  commentTargets = [],
  contextLines = 3,
  error,
  focusCommentTarget,
  lineSelection,
  loading,
  newFile,
  newLabel,
  oldFile,
  oldLabel,
  onClose,
  onCommentRange,
  onContextLinesChange,
  onOpenFile,
  openFileUrl,
  originalPath,
  patch,
  path,
  showClose = true,
  subtitle,
  truncated,
}: {
  binary?: boolean;
  commentTargets?: readonly GitDiffCommentTarget[];
  contextLines?: number;
  error: unknown;
  focusCommentTarget?: GitDiffCommentTarget | null;
  lineSelection?: GitDiffLineSelection;
  loading: boolean;
  newFile?: GitDiffFilePreview;
  newLabel: string;
  oldFile?: GitDiffFilePreview;
  oldLabel: string;
  onClose(): void;
  onCommentRange?(selection: GitDiffCommentSelection): void;
  onContextLinesChange?(contextLines: number): void;
  onOpenFile?(): void;
  openFileUrl?: string | null;
  originalPath?: string | null;
  patch: string | undefined;
  path: string;
  showClose?: boolean;
  subtitle: string;
  truncated: boolean;
}) {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [commentSelection, setCommentSelection] = useState<{
    anchor: GitDiffCommentTarget;
    focus: GitDiffCommentTarget;
  } | null>(null);
  const [copyState, setCopyState] = useState<"path" | "patch" | null>(null);
  const [activeHunk, setActiveHunk] = useState(0);
  const [activeComment, setActiveComment] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const parsedRows = useMemo(() => parseRichUnifiedDiff(patch ?? ""), [patch]);
  const rows = useMemo(
    () =>
      ignoreWhitespace ? hideWhitespaceOnlyChanges(parsedRows) : parsedRows,
    [ignoreWhitespace, parsedRows],
  );
  const splitRows = useMemo(() => buildSplitDiffRows(rows), [rows]);
  const hunkCount = rows.filter(({ kind }) => kind === "hunk").length;
  const visibleCommentTargets = useMemo(
    () =>
      commentTargets.filter(
        (target, index) =>
          commentTargets.findIndex(
            (candidate) =>
              candidate.line === target.line && candidate.side === target.side,
          ) === index,
      ),
    [commentTargets],
  );
  const media =
    oldFile?.kind === "image" ||
    newFile?.kind === "image" ||
    (rows.every(({ kind }) => kind !== "line") &&
      (binary || oldFile?.kind === "binary" || newFile?.kind === "binary"));

  useEffect(() => {
    setActiveHunk(0);
    setActiveComment(0);
    setCommentSelection(null);
  }, [patch, path]);

  const scrollTo = (selector: string, index: number) => {
    const nodes = scrollerRef.current?.querySelectorAll<HTMLElement>(selector);
    const node = nodes?.[index];
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  useEffect(() => {
    if (!focusCommentTarget) return;
    scrollTo(
      `[data-comment-target="${focusCommentTarget.side}:${focusCommentTarget.line}"]`,
      0,
    );
  }, [focusCommentTarget?.line, focusCommentTarget?.side, patch, path]);
  const navigateHunk = (direction: -1 | 1) => {
    if (!hunkCount) return;
    const next = (activeHunk + direction + hunkCount) % hunkCount;
    setActiveHunk(next);
    scrollTo("[data-diff-hunk]", next);
  };
  const navigateComment = (direction: -1 | 1) => {
    if (!visibleCommentTargets.length) return;
    const next =
      (activeComment + direction + visibleCommentTargets.length) %
      visibleCommentTargets.length;
    setActiveComment(next);
    const target = visibleCommentTargets[next]!;
    scrollTo(`[data-comment-target="${target.side}:${target.line}"]`, 0);
  };
  const chooseCommentLine = (
    event: React.MouseEvent,
    line: number,
    side: "LEFT" | "RIGHT",
  ) => {
    const target = { line, side };
    setCommentSelection((current) => ({
      anchor:
        event.shiftKey && current?.anchor.side === side
          ? current.anchor
          : target,
      focus: target,
    }));
  };
  const submitCommentSelection = () => {
    if (!commentSelection || !onCommentRange) return;
    const side = commentSelection.focus.side;
    const start = Math.min(
      commentSelection.anchor.line,
      commentSelection.focus.line,
    );
    const end = Math.max(
      commentSelection.anchor.line,
      commentSelection.focus.line,
    );
    const selectedText = rows
      .filter((row): row is RichDiffLine => row.kind === "line")
      .filter((row) => {
        const number = lineNumber(row, side);
        return number !== null && number >= start && number <= end;
      })
      .map(({ text }) => text)
      .join("\n");
    onCommentRange({
      line: end,
      side,
      selectedText,
      startLine: start === end ? null : start,
      startSide: start === end ? null : side,
    });
    setCommentSelection(null);
  };
  const copy = async (kind: "path" | "patch", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopyState(kind);
    window.setTimeout(() => setCopyState(null), 1_500);
  };
  const openFile = () => {
    if (onOpenFile) onOpenFile();
    else if (openFileUrl) void openExternalUrl(openFileUrl);
  };
  const hasOpenAction = Boolean(onOpenFile || openFileUrl);

  const hunkRow = (row: Extract<RichDiffRow, { kind: "hunk" }>) => {
    const lineIndexes = rows
      .filter(
        (candidate): candidate is RichDiffLine =>
          candidate.kind === "line" &&
          candidate.hunkIndex === row.hunkIndex &&
          candidate.lineKind !== "context",
      )
      .map(({ lineIndex }) => lineIndex);
    const selected =
      lineIndexes.length > 0 &&
      lineIndexes.every((lineIndex) =>
        lineSelection?.selected.has(`${row.hunkIndex}:${lineIndex}`),
      );
    return (
      <div
        className="flex min-h-8 items-center gap-2 border-y border-blue-500/15 bg-blue-500/10 px-3 py-1 text-blue-700 dark:text-blue-300"
        data-diff-hunk
        key={`hunk:${row.hunkIndex}`}
      >
        {lineSelection ? (
          <button
            aria-label={`${selected ? "Deselect" : "Select"} hunk ${row.hunkIndex + 1}`}
            className="rounded p-0.5 hover:bg-blue-500/15"
            onClick={() =>
              lineSelection.onToggleHunk(row.hunkIndex, lineIndexes)
            }
            type="button"
          >
            {selected ? (
              <CheckSquare2 className="size-3.5" />
            ) : (
              <Square className="size-3.5" />
            )}
          </button>
        ) : null}
        <code className="truncate font-mono text-[10px]">{row.text}</code>
      </div>
    );
  };
  const gapRow = (row: Extract<RichDiffRow, { kind: "gap" }>) => {
    const count = Math.max(row.oldCount, row.newCount);
    return (
      <div
        className="sticky left-0 flex h-7 min-w-full items-center justify-center border-y bg-muted/30 text-[10px] text-muted-foreground"
        key={`gap:${row.key}`}
      >
        {onContextLinesChange && contextLines < 1_000 ? (
          <button
            className="rounded px-3 py-1 hover:bg-muted hover:text-foreground"
            onClick={() => onContextLinesChange(nextContextLines(contextLines))}
            type="button"
          >
            Expand {count} unchanged line{count === 1 ? "" : "s"}
          </button>
        ) : (
          `${count} unchanged line${count === 1 ? "" : "s"} omitted`
        )}
      </div>
    );
  };
  const metaRow = (
    row: Extract<RichDiffRow, { kind: "meta" }>,
    key: string,
  ) => (
    <div
      className="sticky left-0 min-w-full px-3 py-1 text-[10px] text-muted-foreground"
      key={key}
    >
      {row.text}
    </div>
  );
  const selectionControl = (line: RichDiffLine) => {
    if (!lineSelection || line.lineKind === "context") return null;
    const key = selectionKey(line);
    return (
      <button
        aria-label={`${lineSelection.selected.has(key) ? "Deselect" : "Select"} changed line`}
        className="grid w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
        onClick={() =>
          lineSelection.onToggleLine(line.hunkIndex, line.lineIndex)
        }
        type="button"
      >
        {lineSelection.selected.has(key) ? (
          <CheckSquare2 className="size-3" />
        ) : (
          <Square className="size-3" />
        )}
      </button>
    );
  };
  const commentControl = (line: RichDiffLine, side: "LEFT" | "RIGHT") => {
    if (!onCommentRange) return null;
    const number = lineNumber(line, side);
    const target = number === null ? null : `${side}:${number}`;
    const hasComment =
      number !== null &&
      visibleCommentTargets.some(
        (candidate) => candidate.line === number && candidate.side === side,
      );
    return (
      <button
        aria-label={
          number === null
            ? undefined
            : `Select ${side.toLowerCase()} line ${number} for review`
        }
        className={cn(
          "relative w-11 shrink-0 select-none px-1 text-right text-muted-foreground/60",
          number !== null &&
            "cursor-pointer hover:bg-blue-500/20 hover:text-foreground",
          lineSelected(line, side, commentSelection) &&
            "bg-blue-500/25 text-foreground",
        )}
        data-comment-target={hasComment ? target : undefined}
        disabled={number === null}
        onClick={(event) =>
          number !== null && chooseCommentLine(event, number, side)
        }
        title={
          number !== null
            ? `Select line ${number}; Shift-click to extend the review range`
            : undefined
        }
        type="button"
      >
        {hasComment ? (
          <span className="absolute left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-blue-500" />
        ) : null}
        {number}
      </button>
    );
  };
  const unifiedLine = (line: RichDiffLine, index: number) => (
    <div
      className={cn(
        "flex min-h-5 min-w-max",
        line.lineKind === "delete" &&
          "bg-red-500/10 text-red-950 dark:text-red-100",
        line.lineKind === "add" &&
          "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
      )}
      key={`line:${line.hunkIndex}:${line.lineIndex}:${index}`}
    >
      {selectionControl(line)}
      {commentControl(line, "LEFT")}
      {commentControl(line, "RIGHT")}
      {!onCommentRange ? (
        <>
          <span className="w-11 shrink-0 select-none px-1 text-right text-muted-foreground/45">
            {line.oldNumber}
          </span>
          <span className="w-11 shrink-0 select-none px-1 text-right text-muted-foreground/45">
            {line.newNumber}
          </span>
        </>
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "w-5 shrink-0 select-none text-center",
          line.lineKind === "delete" && "text-red-500",
          line.lineKind === "add" && "text-emerald-500",
          line.lineKind === "context" && "text-muted-foreground/40",
        )}
      >
        {line.lineKind === "delete" ? "−" : line.lineKind === "add" ? "+" : " "}
      </span>
      <pre className="min-w-0 flex-1 overflow-hidden pr-4 whitespace-pre [tab-size:4]">
        <LineText line={line} path={path} />
      </pre>
    </div>
  );
  const splitLine = (
    line: RichDiffLine | null,
    side: "LEFT" | "RIGHT",
    index: number,
  ) => (
    <div
      className={cn(
        "flex min-h-5 min-w-0",
        !line && "bg-muted/15",
        line?.lineKind === "delete" &&
          "bg-red-500/10 text-red-950 dark:text-red-100",
        line?.lineKind === "add" &&
          "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
      )}
      key={`${side}:${line?.hunkIndex ?? "empty"}:${line?.lineIndex ?? index}`}
    >
      {line &&
      ((line.lineKind === "add" && side === "RIGHT") ||
        (line.lineKind !== "add" && side === "LEFT"))
        ? selectionControl(line)
        : null}
      {line ? commentControl(line, side) : null}
      {!onCommentRange ? (
        <span className="w-11 shrink-0 select-none px-1 text-right text-muted-foreground/45">
          {line ? lineNumber(line, side) : null}
        </span>
      ) : null}
      <span className="w-5 shrink-0 select-none text-center text-muted-foreground/50">
        {line?.lineKind === "delete"
          ? "−"
          : line?.lineKind === "add"
            ? "+"
            : " "}
      </span>
      <pre className="min-w-0 flex-1 overflow-hidden pr-3 whitespace-pre [tab-size:4]">
        {line ? <LineText line={line} path={path} /> : " "}
      </pre>
    </div>
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Button
          className="size-8 md:hidden"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back to changed files</span>
        </Button>
        <FileDiff className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-mono text-xs font-medium" title={path}>
              {path}
            </p>
            {originalPath ? (
              <span className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                renamed
              </span>
            ) : null}
          </div>
          <p className="truncate text-[10px] text-muted-foreground">
            {originalPath ? `${originalPath} → ${path} · ` : ""}
            {subtitle}
          </p>
        </div>
        {showClose ? (
          <Button
            className="hidden size-8 md:inline-flex"
            onClick={onClose}
            size="icon"
            title="Close diff"
            variant="ghost"
          >
            <X className="size-4" />
            <span className="sr-only">Close diff</span>
          </Button>
        ) : null}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
        <Button
          aria-pressed={layout === "unified"}
          className="h-7 gap-1.5 px-2 text-[10px]"
          onClick={() => setLayout("unified")}
          size="sm"
          title="Unified diff"
          variant={layout === "unified" ? "outline" : "ghost"}
        >
          <Rows3 className="size-3" /> Unified
        </Button>
        <Button
          aria-pressed={layout === "split"}
          className="h-7 gap-1.5 px-2 text-[10px]"
          onClick={() => setLayout("split")}
          size="sm"
          title="Split diff"
          variant={layout === "split" ? "outline" : "ghost"}
        >
          <Columns2 className="size-3" /> Split
        </Button>
        <Button
          aria-pressed={ignoreWhitespace}
          className="h-7 gap-1.5 px-2 text-[10px]"
          onClick={() => setIgnoreWhitespace((current) => !current)}
          size="sm"
          title="Hide whitespace-only changes"
          variant={ignoreWhitespace ? "outline" : "ghost"}
        >
          <Pilcrow className="size-3" /> Whitespace
        </Button>
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        <Button
          className="size-7"
          disabled={!hunkCount}
          onClick={() => navigateHunk(-1)}
          size="icon"
          title="Previous change"
          variant="ghost"
        >
          <ArrowUp className="size-3" />
        </Button>
        <Button
          className="size-7"
          disabled={!hunkCount}
          onClick={() => navigateHunk(1)}
          size="icon"
          title="Next change"
          variant="ghost"
        >
          <ArrowDown className="size-3" />
        </Button>
        {visibleCommentTargets.length ? (
          <>
            <span className="mx-1 h-4 w-px shrink-0 bg-border" />
            <Button
              className="size-7"
              onClick={() => navigateComment(-1)}
              size="icon"
              title="Previous review comment"
              variant="ghost"
            >
              <MessageSquare className="size-3" />
              <span className="sr-only">Previous review comment</span>
            </Button>
            <Button
              className="size-7"
              onClick={() => navigateComment(1)}
              size="icon"
              title="Next review comment"
              variant="ghost"
            >
              <MessageSquare className="size-3" />
              <span className="sr-only">Next review comment</span>
            </Button>
          </>
        ) : null}
        {commentSelection && onCommentRange ? (
          <Button
            className="ml-1 h-7 gap-1.5 px-2 text-[10px]"
            onClick={submitCommentSelection}
            size="sm"
            variant="outline"
          >
            <MessageSquare className="size-3" /> Comment on selection
          </Button>
        ) : null}
        <span className="ml-auto" />
        {hasOpenAction ? (
          <Button
            className="size-7"
            onClick={openFile}
            size="icon"
            title={onOpenFile ? "Open file" : "Open file on GitHub"}
            variant="ghost"
          >
            <FolderOpen className="size-3" />
          </Button>
        ) : null}
        <Button
          className="size-7"
          onClick={() => void copy("path", path)}
          size="icon"
          title="Copy path"
          variant="ghost"
        >
          {copyState === "path" ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
        <Button
          className="size-7"
          disabled={!patch}
          onClick={() => void copy("patch", patch ?? "")}
          size="icon"
          title="Copy patch"
          variant="ghost"
        >
          {copyState === "patch" ? (
            <Check className="size-3" />
          ) : (
            <FileDiff className="size-3" />
          )}
        </Button>
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
      ) : media ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div
            className={cn("grid gap-3", layout === "split" && "md:grid-cols-2")}
          >
            <DiffFileCard file={oldFile} label={oldLabel} />
            <DiffFileCard file={newFile} label={newLabel} />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" ref={scrollerRef}>
          {truncated ? (
            <div className="sticky left-0 top-0 z-10 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              This diff is very large, so only the first portion is shown.
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="grid min-h-48 place-items-center p-6 text-center text-sm text-muted-foreground">
              No textual line changes to display.
            </div>
          ) : layout === "unified" ? (
            <div
              aria-label={`${oldLabel} to ${newLabel}`}
              className="w-max min-w-full py-1 font-mono text-[11px] leading-5"
            >
              {rows.map((row, index) =>
                row.kind === "hunk"
                  ? hunkRow(row)
                  : row.kind === "gap"
                    ? gapRow(row)
                    : row.kind === "meta"
                      ? metaRow(row, `meta:${index}`)
                      : unifiedLine(row, index),
              )}
            </div>
          ) : (
            <div
              aria-label={`${oldLabel} to ${newLabel}`}
              className="min-w-[44rem] py-1 font-mono text-[11px] leading-5"
            >
              <div className="sticky top-0 z-[5] grid h-7 grid-cols-2 border-b bg-background/95 text-[10px] font-medium backdrop-blur">
                <span className="truncate border-r px-3 py-1.5">
                  {oldLabel}
                </span>
                <span className="truncate px-3 py-1.5">{newLabel}</span>
              </div>
              {splitRows.map((row, index) =>
                row.kind === "hunk" ? (
                  hunkRow(row)
                ) : row.kind === "gap" ? (
                  gapRow(row)
                ) : row.kind === "meta" ? (
                  metaRow(row, `split-meta:${index}`)
                ) : (
                  <div
                    className="grid min-h-5 grid-cols-2"
                    key={`pair:${index}`}
                  >
                    <div className="min-w-0 border-r">
                      {splitLine(row.left, "LEFT", index)}
                    </div>
                    <div className="min-w-0">
                      {splitLine(row.right, "RIGHT", index)}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
