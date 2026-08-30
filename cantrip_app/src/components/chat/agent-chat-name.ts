import agentNamesSource from "@/data/names.txt?raw";

export const DEFAULT_AGENT_CHAT_TITLE = "New agent";
export const AGENT_CHAT_NAME_ATTEMPTS = 5;

export function parseAgentChatNames(source: string): string[] {
  return [
    ...new Set(source.split(/[\s,]+/u).map((name) => name.trim())),
  ].filter(Boolean);
}

export const AGENT_CHAT_NAMES = parseAgentChatNames(agentNamesSource);

function comparableTitle(title: string): string {
  return title.trim().toLocaleLowerCase();
}

export function randomAgentChatTitle(
  existingTitles: readonly string[],
  options: {
    names?: readonly string[];
    random?: () => number;
  } = {},
): string {
  const names = options.names ?? AGENT_CHAT_NAMES;
  if (names.length === 0) return DEFAULT_AGENT_CHAT_TITLE;
  const random = options.random ?? Math.random;
  const occupied = new Set(existingTitles.map(comparableTitle));
  for (let attempt = 0; attempt < AGENT_CHAT_NAME_ATTEMPTS; attempt += 1) {
    const index = Math.min(
      names.length - 1,
      Math.max(0, Math.floor(random() * names.length)),
    );
    const candidate = names[index]?.trim();
    if (candidate && !occupied.has(comparableTitle(candidate))) {
      return candidate;
    }
  }
  return DEFAULT_AGENT_CHAT_TITLE;
}

export function newAgentChatTitle(
  existingTitles: readonly string[],
  randomNames: boolean,
): string {
  return randomNames
    ? randomAgentChatTitle(existingTitles)
    : DEFAULT_AGENT_CHAT_TITLE;
}
