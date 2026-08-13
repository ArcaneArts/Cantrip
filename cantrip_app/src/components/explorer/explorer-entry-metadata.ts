import type {
  ExplorerEntry,
  ExplorerLastCommit,
  GitFileChange,
  GitStatus,
} from "@cantrip/protocol";

export type ExplorerChangeKind =
  "added" | "conflict" | "deleted" | "modified" | "renamed" | "untracked";

export interface ExplorerChangeSummary {
  code: string;
  count: number;
  kind: ExplorerChangeKind;
  label: string;
}

export interface ExplorerCommitMetadata {
  age: string;
  compactLabel: string;
  subject: string;
  tooltip: string;
}

const conflictCodes = new Set(["AA", "AU", "DD", "DU", "UA", "UD", "UU"]);
const changePriority: Record<ExplorerChangeKind, number> = {
  conflict: 6,
  untracked: 5,
  added: 4,
  renamed: 3,
  deleted: 2,
  modified: 1,
};

function changeKind(change: GitFileChange): ExplorerChangeKind {
  const status = `${change.indexStatus}${change.worktreeStatus}`;
  if (conflictCodes.has(status)) return "conflict";
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (/[RC]/u.test(status)) return "renamed";
  if (status.includes("D")) return "deleted";
  return "modified";
}

function changeCode(kind: ExplorerChangeKind): string {
  if (kind === "conflict") return "!";
  if (kind === "untracked") return "?";
  return kind[0]!.toUpperCase();
}

function changeSummary(
  count: number,
  kind: ExplorerChangeKind,
): ExplorerChangeSummary {
  return {
    code: count === 1 ? changeCode(kind) : count > 99 ? "99+" : String(count),
    count,
    kind,
    label:
      count === 1
        ? `${kind[0]!.toUpperCase()}${kind.slice(1)} locally`
        : `${count} local changes`,
  };
}

export function sortExplorerEntries(
  entries: readonly ExplorerEntry[],
): ExplorerEntry[] {
  const rank = (entry: ExplorerEntry) =>
    entry.kind === "directory" ? 0 : entry.kind === "file" ? 1 : 2;
  return [...entries].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}

export function formatExplorerSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  if (size < 1_073_741_824) {
    return `${(size / 1_048_576).toFixed(1)} MB`;
  }
  return `${(size / 1_073_741_824).toFixed(1)} GB`;
}

export function buildExplorerChangeIndex(
  status: GitStatus | undefined,
): ReadonlyMap<string, ExplorerChangeSummary> {
  if (!status) return new Map();
  const aggregate = new Map<
    string,
    { count: number; kind: ExplorerChangeKind }
  >();
  const add = (path: string, kind: ExplorerChangeKind) => {
    const current = aggregate.get(path);
    aggregate.set(path, {
      count: (current?.count ?? 0) + 1,
      kind:
        current && changePriority[current.kind] >= changePriority[kind]
          ? current.kind
          : kind,
    });
  };
  for (const change of status.files) {
    const kind = changeKind(change);
    add(change.path, kind);
    const segments = change.path.split("/");
    segments.pop();
    while (segments.length > 0) {
      add(segments.join("/"), kind);
      segments.pop();
    }
  }
  return new Map(
    [...aggregate].map(([path, value]) => [
      path,
      changeSummary(value.count, value.kind),
    ]),
  );
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function formatExplorerRelativeDate(
  value: string,
  now = Date.now(),
): string {
  const delta = new Date(value).getTime() - now;
  const hours = Math.round(delta / 3_600_000);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  const days = Math.round(delta / 86_400_000);
  if (Math.abs(days) < 30) return relativeTime.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return relativeTime.format(months, "month");
  return relativeTime.format(Math.round(days / 365), "year");
}

export function explorerCommitMetadata(
  commit: ExplorerLastCommit,
  now = Date.now(),
): ExplorerCommitMetadata {
  const subject = commit.subject || commit.shortHash;
  const age = formatExplorerRelativeDate(commit.authoredAt, now);
  const author = commit.authorEmail
    ? `${commit.authorName} <${commit.authorEmail}>`
    : commit.authorName;
  return {
    age,
    compactLabel: `${subject} · ${age}`,
    subject,
    tooltip: [subject, commit.hash, author, commit.authoredAt].join("\n"),
  };
}
