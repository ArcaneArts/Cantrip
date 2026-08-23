import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_NAME_ATTEMPTS,
  AGENT_CHAT_NAMES,
  DEFAULT_AGENT_CHAT_TITLE,
  parseAgentChatNames,
  randomAgentChatTitle,
} from "./agent-chat-name";

function randomSequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("agent chat names", () => {
  it("loads and deduplicates the preset name file", () => {
    expect(AGENT_CHAT_NAMES).toContain("Adam");
    expect(AGENT_CHAT_NAMES).toContain("Dom");
    expect(AGENT_CHAT_NAMES.filter((name) => name === "Alex")).toHaveLength(1);
    expect(parseAgentChatNames(" Ada, Bob\nAda ")).toEqual(["Ada", "Bob"]);
  });

  it("selects a random available first name", () => {
    expect(
      randomAgentChatTitle([], {
        names: ["Adam", "Zoe"],
        random: () => 0.75,
      }),
    ).toBe("Zoe");
  });

  it("retries collisions case-insensitively until it finds a unique title", () => {
    expect(
      randomAgentChatTitle([" adam "], {
        names: ["Adam", "Zoe"],
        random: randomSequence([0, 0, 0.75]),
      }),
    ).toBe("Zoe");
  });

  it("falls back after five colliding draws", () => {
    let draws = 0;
    expect(
      randomAgentChatTitle(["Adam"], {
        names: ["Adam"],
        random: () => {
          draws += 1;
          return 0;
        },
      }),
    ).toBe(DEFAULT_AGENT_CHAT_TITLE);
    expect(draws).toBe(AGENT_CHAT_NAME_ATTEMPTS);
  });
});
