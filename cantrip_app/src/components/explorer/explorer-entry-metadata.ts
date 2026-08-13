import type {
  ExplorerEntry,
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

export function explorerEntryChange(
  entry: ExplorerEntry,
  status: GitStatus | undefined,
): ExplorerChangeSummary | null {
  if (!status) return null;
  const prefix = `${entry.path}/`;
  const changes = status.files.filter(({ path }) =>
    entry.kind === "directory" ? path.startsWith(prefix) : path === entry.path,
  );
  if (changes.length === 0) return null;
  const kind = changes
    .map(changeKind)
    .sort((left, right) => changePriority[right] - changePriority[left])[0]!;
  const label =
    changes.length === 1
      ? `${kind[0]!.toUpperCase()}${kind.slice(1)} locally`
      : `${changes.length} local changes`;
  return {
    code: changes.length === 1 ? changeCode(kind) : String(changes.length),
    count: changes.length,
    kind,
    label,
  };
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
