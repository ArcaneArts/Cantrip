import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import { ChevronDown, ChevronUp, FileDiff, FileText } from "lucide-react";
import { useState } from "react";

import type { AgentTranscriptEntry } from "@/components/chat/agent-turn-projection";
import {
  displayMarkdownFileReference,
  markdownFileReferences,
} from "@/components/chat/markdown-file-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FileChange = Extract<
  AgentActivity,
  { type: "fileChange" }
>["changes"][number];

export interface MessageFileEntry {
  additions: number | null;
  deletions: number | null;
  edited: boolean;
  path: string;
  reference: string;
  referenced: boolean;
}

export interface MessageFileSummaryModel {
  additions: number;
  deletions: number;
  entries: MessageFileEntry[];
  title: "Files Edited" | "Files Edited and Referenced" | "Files Referenced";
}

function normalizedReferenceKey(reference: string): string {
  return displayMarkdownFileReference(reference)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
}

function sameFileReference(left: string, right: string): boolean {
  let leftKey = normalizedReferenceKey(left);
  let rightKey = normalizedReferenceKey(right);
  if (/^[a-z]:\//i.test(leftKey) || /^[a-z]:\//i.test(rightKey)) {
    leftKey = leftKey.toLowerCase();
    rightKey = rightKey.toLowerCase();
  }
  return (
    leftKey === rightKey ||
    leftKey.endsWith(`/${rightKey}`) ||
    rightKey.endsWith(`/${leftKey}`)
  );
}

export function fileChangeLineCounts(change: FileChange): {
  additions: number | null;
  deletions: number | null;
} {
  if (!change.diffPreview) return { additions: null, deletions: null };
  let additions = 0;
  let deletions = 0;
  for (const line of change.diffPreview.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function messageReferences(message: ChatMessage): string[] {
  return message.content.flatMap((content) =>
    content.type === "text" && content.phase !== "commentary"
      ? markdownFileReferences(content.text)
      : [],
  );
}

function finalAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.some(
      (content) =>
        content.type === "text" &&
        content.phase !== "commentary" &&
        content.streaming !== true,
    )
  );
}

function activityChanges(entry: AgentTranscriptEntry): FileChange[] {
  if (entry.type !== "timeline" || entry.entry.type !== "activityGroup") {
    return [];
  }
  return entry.entry.messages.flatMap((message) =>
    message.content.flatMap((content) =>
      content.type === "activity" && content.activity.type === "fileChange"
        ? content.activity.changes
        : [],
    ),
  );
}

export function editedFilesByAssistantMessage(
  entries: readonly AgentTranscriptEntry[],
): ReadonlyMap<string, FileChange[]> {
  const result = new Map<string, FileChange[]>();
  const pending = new Map<string, FileChange>();
  for (const transcriptEntry of entries) {
    if (transcriptEntry.type === "agent") continue;
    const entry = transcriptEntry.entry;
    if (entry.type === "activityGroup") {
      for (const change of activityChanges(transcriptEntry)) {
        const key = normalizedReferenceKey(change.path);
        const previous = pending.get(key);
        const previousCounts = previous ? fileChangeLineCounts(previous) : null;
        const nextCounts = fileChangeLineCounts(change);
        const previousHasCounts = Boolean(
          previousCounts &&
          (previousCounts.additions !== null ||
            previousCounts.deletions !== null),
        );
        const nextHasCounts =
          nextCounts.additions !== null || nextCounts.deletions !== null;
        pending.set(
          key,
          previous && previousHasCounts && !nextHasCounts ? previous : change,
        );
      }
      continue;
    }
    if (entry.message.role === "user" || entry.message.role === "system") {
      pending.clear();
      continue;
    }
    if (!finalAssistantMessage(entry.message)) continue;
    if (pending.size > 0) {
      result.set(entry.message.id, [...pending.values()]);
      pending.clear();
    }
  }
  return result;
}

export function messageFileSummary(
  message: ChatMessage,
  changes: readonly FileChange[],
): MessageFileSummaryModel | null {
  if (!finalAssistantMessage(message)) return null;
  const entries: MessageFileEntry[] = changes.map((change) => ({
    ...fileChangeLineCounts(change),
    edited: true,
    path: displayMarkdownFileReference(change.path),
    reference: change.path,
    referenced: false,
  }));
  const references = messageReferences(message);
  for (const reference of references) {
    const existing = entries.find((entry) =>
      sameFileReference(entry.reference, reference),
    );
    if (existing) {
      existing.referenced = true;
      continue;
    }
    entries.push({
      additions: null,
      deletions: null,
      edited: false,
      path: displayMarkdownFileReference(reference),
      reference,
      referenced: true,
    });
  }
  if (entries.length === 0) return null;
  const edited = entries.some((entry) => entry.edited);
  const referenced = entries.some((entry) => entry.referenced);
  return {
    additions: entries.reduce(
      (total, entry) => total + (entry.additions ?? 0),
      0,
    ),
    deletions: entries.reduce(
      (total, entry) => total + (entry.deletions ?? 0),
      0,
    ),
    entries,
    title:
      edited && referenced
        ? "Files Edited and Referenced"
        : edited
          ? "Files Edited"
          : "Files Referenced",
  };
}

const INITIAL_VISIBLE_FILES = 3;

export function MessageFileSummary({
  model,
  onOpenFile,
}: {
  model: MessageFileSummaryModel;
  onOpenFile(path: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleEntries = expanded
    ? model.entries
    : model.entries.slice(0, INITIAL_VISIBLE_FILES);
  const hiddenCount = model.entries.length - visibleEntries.length;
  return (
    <section
      aria-label={model.title}
      className="mt-4 overflow-hidden rounded-xl border bg-card/40 text-sm"
      data-slot="message-file-summary"
    >
      <header className="flex min-w-0 items-center gap-3 border-b px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/60">
          <FileDiff className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{model.title}</p>
          {model.additions > 0 || model.deletions > 0 ? (
            <p className="text-xs tabular-nums">
              <span className="text-emerald-500">+{model.additions}</span>{" "}
              <span className="text-destructive">-{model.deletions}</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {model.entries.length}{" "}
              {model.entries.length === 1 ? "file" : "files"}
            </p>
          )}
        </div>
      </header>
      <div className="divide-y">
        {visibleEntries.map((entry) => (
          <button
            className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            key={`${entry.reference}:${entry.edited ? "edited" : "referenced"}`}
            onClick={() => onOpenFile(entry.reference)}
            title={entry.path}
            type="button"
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs">
              {entry.path}
            </code>
            {entry.additions !== null || entry.deletions !== null ? (
              <span className="shrink-0 text-xs tabular-nums">
                <span className="text-emerald-500">
                  +{entry.additions ?? 0}
                </span>{" "}
                <span className="text-destructive">
                  -{entry.deletions ?? 0}
                </span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {hiddenCount > 0 || expanded ? (
        <Button
          className={cn("h-9 w-full justify-start rounded-none border-t px-3")}
          onClick={() => setExpanded((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {expanded ? (
            <>
              Show fewer files <ChevronUp className="size-3.5" />
            </>
          ) : (
            <>
              Show {hiddenCount} more {hiddenCount === 1 ? "file" : "files"}{" "}
              <ChevronDown className="size-3.5" />
            </>
          )}
        </Button>
      ) : null}
    </section>
  );
}
