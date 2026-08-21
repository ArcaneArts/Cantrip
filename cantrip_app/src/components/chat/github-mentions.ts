import type { GithubIssueKind, GithubIssueSummary } from "@cantrip/protocol";

export interface GithubReference extends GithubIssueSummary {
  kind: GithubIssueKind;
}

export interface ActiveGithubMention {
  start: number;
  end: number;
  query: string;
}

export function activeGithubMention(
  draft: string,
  caret: number,
): ActiveGithubMention | null {
  const safeCaret = Math.max(0, Math.min(caret, draft.length));
  const beforeCaret = draft.slice(0, safeCaret);
  const match = /(?:^|[\s([{])#([^\s#]*)$/u.exec(beforeCaret);
  if (!match) return null;

  const start = beforeCaret.lastIndexOf("#");
  let end = safeCaret;
  while (end < draft.length && !/\s/u.test(draft[end] ?? "")) end += 1;
  return { start, end, query: match[1] ?? "" };
}

export function filterGithubReferences(
  references: readonly GithubReference[],
  query: string,
  limit = 50,
): GithubReference[] {
  const normalized = query.toLocaleLowerCase();
  return references
    .flatMap((reference) => {
      const number = String(reference.number);
      const title = reference.title.toLocaleLowerCase();
      const rank =
        number === normalized
          ? 0
          : normalized && number.startsWith(normalized)
            ? 1
            : !normalized || title.startsWith(normalized)
              ? 2
              : title.split(/\s+/u).some((word) => word.startsWith(normalized))
                ? 3
                : title.includes(normalized)
                  ? 4
                  : null;
      return rank === null ? [] : [{ rank, reference }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        Number(left.reference.state === "closed") -
          Number(right.reference.state === "closed") ||
        Date.parse(right.reference.updatedAt) -
          Date.parse(left.reference.updatedAt) ||
        right.reference.number - left.reference.number,
    )
    .slice(0, limit)
    .map(({ reference }) => reference);
}

export function insertGithubMention(
  draft: string,
  mention: ActiveGithubMention,
  reference: GithubReference,
): { text: string; caret: number } {
  const hasFollowingSpace = /\s/u.test(draft[mention.end] ?? "");
  const insertion = `#${reference.number}${hasFollowingSpace ? "" : " "}`;
  return {
    text: `${draft.slice(0, mention.start)}${insertion}${draft.slice(mention.end)}`,
    caret: mention.start + insertion.length + (hasFollowingSpace ? 1 : 0),
  };
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/gu, "\\$&");
}

function referenceTokenPattern(number: number): RegExp {
  return new RegExp(`(^|[\\s([{])#${number}(?=$|[\\s\\])},.!?:;])`, "gu");
}

export function containsGithubReference(
  draft: string,
  reference: GithubReference,
): boolean {
  return referenceTokenPattern(reference.number).test(draft);
}

export function expandGithubReferences(
  draft: string,
  references: readonly GithubReference[],
): string {
  let expanded = draft;
  const unique = new Map(
    references.map((reference) => [reference.number, reference]),
  );
  for (const reference of unique.values()) {
    const label = escapeMarkdownLabel(
      `${reference.kind === "pull-request" ? "PR" : "Issue"} #${reference.number}: ${reference.title}`,
    );
    const token = referenceTokenPattern(reference.number);
    expanded = expanded.replace(
      token,
      (_match, prefix: string) => `${prefix}[${label}](${reference.url})`,
    );
  }
  return expanded;
}
