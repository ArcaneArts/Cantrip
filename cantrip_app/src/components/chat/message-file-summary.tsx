import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import type { ChatFileReferencesResult } from "@cantrip/protocol/surface-stream";
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useState } from "react";

import type { AgentTranscriptEntry } from "@/components/chat/agent-turn-projection";
import {
  displayMarkdownFileReference,
  markdownFileReferences,
} from "@/components/chat/markdown-file-link";
import {
  messageFileTree,
  messageFileTreeCounts,
  type MessageFileTreeNode,
} from "./message-file-tree";

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

function MessageFileTreeItem({
  depth = 0,
  node,
  onOpenFile,
}: {
  depth?: number;
  node: MessageFileTreeNode;
  onOpenFile(path: string): void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const folder = node.kind === "directory";
  const Icon = folder ? (expanded ? FolderOpen : Folder) : FileText;
  const entry = node.entry;
  return (
    <li>
      <button
        aria-expanded={folder ? expanded : undefined}
        className="flex w-full min-w-0 items-center gap-2 border-t px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        data-file-kind={node.kind}
        onClick={() => {
          if (folder) setExpanded((current) => !current);
          else if (entry) onOpenFile(entry.reference);
        }}
        style={{ paddingLeft: 12 + depth * 16 }}
        title={node.path}
        type="button"
      >
        {folder ? (
          expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {node.name}
        </code>
        {entry && (entry.additions !== null || entry.deletions !== null) ? (
          <span className="shrink-0 text-xs tabular-nums">
            <span className="text-emerald-500">+{entry.additions ?? 0}</span>{" "}
            <span className="text-destructive">-{entry.deletions ?? 0}</span>
          </span>
        ) : null}
      </button>
      {folder && expanded ? (
        node.children.length > 0 ? (
          <ul aria-label={node.path || node.name}>
            {node.children.map((child) => (
              <MessageFileTreeItem
                depth={depth + 1}
                key={child.path}
                node={child}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        ) : (
          <p
            className="py-2 pr-3 text-xs text-muted-foreground"
            style={{ paddingLeft: 44 + depth * 16 }}
          >
            No referenced files in this folder.
          </p>
        )
      ) : null}
    </li>
  );
}

export function MessageFileSummary({
  metadata,
  model,
  onOpenFile,
}: {
  metadata?: ChatFileReferencesResult;
  model: MessageFileSummaryModel;
  onOpenFile(path: string): void;
}) {
  const root = messageFileTree(model.entries, metadata);
  if (!root) return null;
  const counts = messageFileTreeCounts(root);
  return (
    <section
      aria-label={model.title}
      className="mt-4 overflow-hidden rounded-xl border bg-card/40 text-sm"
      data-slot="message-file-summary"
    >
      <header className="flex min-w-0 items-center gap-3 px-3 py-2.5">
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
              {counts.files} {counts.files === 1 ? "file" : "files"}
              {counts.folders > 0
                ? ` · ${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`
                : null}
            </p>
          )}
        </div>
      </header>
      <ul aria-label="Referenced file tree">
        <MessageFileTreeItem
          key={root.path}
          node={root}
          onOpenFile={onOpenFile}
        />
      </ul>
    </section>
  );
}
