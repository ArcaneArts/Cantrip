import { safeFetch, type SafeFetchOptions } from "./safe-fetch.js";

const ROBOTS_TTL_MS = 10 * 60_000;
const ROBOTS_LIMIT_BYTES = 512_000;

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface CachedRules {
  expiresAt: number;
  rules: RobotsRule[];
}

function matchingRules(contents: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let group: { agents: string[]; rules: RobotsRule[] } | null = null;
  let sawRule = false;
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!group || sawRule) {
        group = { agents: [], rules: [] };
        groups.push(group);
        sawRule = false;
      }
      group.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && group) {
      sawRule = true;
      if (value) group.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const cantrip = groups.filter(({ agents }) =>
    agents.some((agent) => agent === "cantripresearchbot"),
  );
  const selected =
    cantrip.length > 0
      ? cantrip
      : groups.filter(({ agents }) => agents.includes("*"));
  return selected.flatMap(({ rules }) => rules);
}

function ruleMatches(pathname: string, pattern: string): boolean {
  const endAnchored = pattern.endsWith("$");
  const source = (endAnchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${endAnchored ? "$" : ""}`, "u").test(pathname);
}

export class RobotsPolicy {
  readonly #cache = new Map<string, CachedRules>();
  readonly #fetch: typeof safeFetch;
  readonly #fetchOptions: SafeFetchOptions;
  readonly #now: () => number;

  constructor(
    options: {
      fetch?: typeof safeFetch;
      fetchOptions?: SafeFetchOptions;
      now?: () => number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? safeFetch;
    this.#fetchOptions = options.fetchOptions ?? {};
    this.#now = options.now ?? Date.now;
  }

  async assertAllowed(url: URL): Promise<void> {
    const origin = url.origin;
    let cached = this.#cache.get(origin);
    if (!cached || cached.expiresAt <= this.#now()) {
      const robotsUrl = new URL("/robots.txt", origin);
      const response = await this.#fetch(robotsUrl.href, {
        ...this.#fetchOptions,
        beforeRequest: undefined,
        compressedByteLimit: ROBOTS_LIMIT_BYTES,
        contentTypes: ["text/plain", "text/html"],
        expandedByteLimit: ROBOTS_LIMIT_BYTES,
        timeoutMs: 10_000,
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "The site's robots policy does not allow autonomous reading.",
        );
      }
      if (response.status >= 500) {
        throw new Error("The site's robots policy is temporarily unavailable.");
      }
      cached = {
        expiresAt: this.#now() + ROBOTS_TTL_MS,
        rules:
          response.status >= 200 && response.status < 300
            ? matchingRules(response.body.toString("utf8"))
            : [],
      };
      this.#cache.set(origin, cached);
      if (this.#cache.size > 500)
        this.#cache.delete(this.#cache.keys().next().value!);
    }
    const candidate = `${url.pathname}${url.search}`;
    const matching = cached.rules
      .filter(({ pattern }) => ruleMatches(candidate, pattern))
      .sort(
        (left, right) =>
          right.pattern.length - left.pattern.length ||
          Number(right.allow) - Number(left.allow),
      );
    if (matching[0] && !matching[0].allow) {
      throw new Error(
        "The site's robots policy does not allow autonomous reading of this URL.",
      );
    }
  }
}
