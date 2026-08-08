import type { SkillSummary } from "@cantrip/protocol";

const SKILL_NAME_CHARACTER = /[A-Za-z0-9_.:-]/u;

export interface ActiveSkillMention {
  start: number;
  end: number;
  query: string;
}

export interface SkillMentionSegment {
  text: string;
  skill: SkillSummary | null;
}

export function activeSkillMention(
  draft: string,
  caret: number,
): ActiveSkillMention | null {
  const safeCaret = Math.max(0, Math.min(caret, draft.length));
  const beforeCaret = draft.slice(0, safeCaret);
  const match = /(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9_.:-]*)$/u.exec(beforeCaret);
  if (!match) return null;
  const start = beforeCaret.lastIndexOf("$");
  let end = safeCaret;
  while (end < draft.length && SKILL_NAME_CHARACTER.test(draft[end] ?? "")) {
    end += 1;
  }
  return { start, end, query: match[1] ?? "" };
}

export function filterSkills(
  skills: readonly SkillSummary[],
  query: string,
): SkillSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  return skills
    .flatMap((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const displayName = (skill.displayName ?? "").toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const rank =
        !normalized || name.startsWith(normalized)
          ? 0
          : displayName.startsWith(normalized)
            ? 1
            : name.includes(normalized)
              ? 2
              : displayName.includes(normalized)
                ? 3
                : description.includes(normalized)
                  ? 4
                  : null;
      return rank === null ? [] : [{ skill, rank }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.skill.name.localeCompare(right.skill.name),
    )
    .slice(0, 100)
    .map(({ skill }) => skill);
}

export function insertSkillMention(
  draft: string,
  mention: ActiveSkillMention,
  skillName: string,
): { text: string; caret: number } {
  const hasFollowingSpace = /\s/u.test(draft[mention.end] ?? "");
  const insertion = `$${skillName}${hasFollowingSpace ? "" : " "}`;
  return {
    text: `${draft.slice(0, mention.start)}${insertion}${draft.slice(mention.end)}`,
    caret: mention.start + insertion.length + (hasFollowingSpace ? 1 : 0),
  };
}

export function skillMentionSegments(
  draft: string,
  skills: readonly SkillSummary[],
): SkillMentionSegment[] {
  if (!draft) return [];
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const segments: SkillMentionSegment[] = [];
  let cursor = 0;
  for (const match of draft.matchAll(
    /(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu,
  )) {
    const skill = byName.get(match[1] ?? "");
    if (!skill || match.index === undefined) continue;
    const start = match.index + match[0].lastIndexOf("$");
    if (start > cursor) {
      segments.push({ text: draft.slice(cursor, start), skill: null });
    }
    const end = start + skill.name.length + 1;
    segments.push({ text: draft.slice(start, end), skill });
    cursor = end;
  }
  if (cursor < draft.length) {
    segments.push({ text: draft.slice(cursor), skill: null });
  }
  return segments;
}
