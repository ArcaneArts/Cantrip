import type { AgentActivity } from "@cantrip/protocol";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { SyntaxHighlightedCode } from "./markdown-code";

type FileChangeActivity = Extract<AgentActivity, { type: "fileChange" }>;
export type FileChangePreviewChange = FileChangeActivity["changes"][number];

const extensionLanguages: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  go: "go",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  html: "markup",
  java: "java",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sol: "solidity",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const filenameLanguages: Record<string, string> = {
  gemfile: "ruby",
};

export function filePreviewLanguage(path: string): string | null {
  const filename = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const byFilename = filenameLanguages[filename];
  if (byFilename) return byFilename;
  const extension = filename.includes(".") ? filename.split(".").at(-1) : null;
  return extension ? (extensionLanguages[extension] ?? null) : null;
}

export interface FileChangePreviewLine {
  code: string;
  marker: "+" | "-" | " ";
}

export function fileChangePreviewLines(
  change: FileChangePreviewChange,
): FileChangePreviewLine[] {
  const preview = change.diffPreview?.trimEnd();
  if (preview) {
    return preview.split(/\r?\n/u).map((line) => {
      const marker = line[0] === "+" || line[0] === "-" ? line[0] : " ";
      return { code: marker === " " ? line : line.slice(1), marker };
    });
  }
  if (change.latestLine !== null && change.latestLine !== undefined) {
    const marker = change.kind === "delete" ? "-" : "+";
    return change.latestLine.split(/\r?\n/u).map((code) => ({ code, marker }));
  }
  return change.kind === "delete"
    ? [{ code: "File deleted", marker: "-" }]
    : [];
}

function changeLabel(kind: FileChangePreviewChange["kind"]): string {
  if (kind === "add") return "Added";
  if (kind === "delete") return "Deleted";
  return "Updated";
}

function markerClass(marker: FileChangePreviewLine["marker"]): string {
  if (marker === "+") return "text-emerald-500";
  if (marker === "-") return "text-destructive";
  return "text-muted-foreground";
}

function ChangePreview({ change }: { change: FileChangePreviewChange }) {
  const lines = fileChangePreviewLines(change);
  const language = filePreviewLanguage(change.path);
  return (
    <article
      className="min-w-0 overflow-hidden rounded-md border bg-muted/20"
      data-file-path={change.path}
      data-slot="file-change-preview"
    >
      <header className="flex min-w-0 items-center gap-2 border-b bg-muted/25 px-2 py-1.5">
        <Badge
          className={cn(
            "h-5 shrink-0 px-1.5 text-[10px] font-normal",
            change.kind === "delete" && "text-destructive",
          )}
          variant="secondary"
        >
          {changeLabel(change.kind)}
        </Badge>
        <code
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={change.path}
        >
          {change.path}
        </code>
      </header>
      {lines.length > 0 ? (
        <div
          aria-label={`Preview of changes in ${change.path}`}
          className="grid max-h-48 grid-cols-[1.75rem_minmax(0,1fr)] overflow-auto bg-background/35"
          data-language={language ?? "plain-text"}
        >
          <pre
            aria-hidden="true"
            className="border-r bg-muted/20 py-2 text-center font-mono text-xs leading-5"
          >
            {lines.map((line, index) => (
              <span
                className={cn("block", markerClass(line.marker))}
                key={index}
              >
                {line.marker}
              </span>
            ))}
          </pre>
          <pre className="min-w-max overflow-visible py-2 pl-2 pr-3">
            <SyntaxHighlightedCode
              className={language ? `language-${language}` : undefined}
            >
              {lines.map((line) => line.code).join("\n")}
            </SyntaxHighlightedCode>
          </pre>
        </div>
      ) : (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">
          Preview unavailable.
        </p>
      )}
    </article>
  );
}

export function FileChangePreview({
  changes,
  className,
}: {
  changes: readonly FileChangePreviewChange[];
  className?: string;
}) {
  if (changes.length === 0) return null;
  return (
    <div
      className={cn("space-y-2", className)}
      data-slot="file-change-preview-list"
    >
      {changes.map((change) => (
        <ChangePreview change={change} key={`${change.kind}:${change.path}`} />
      ))}
    </div>
  );
}
