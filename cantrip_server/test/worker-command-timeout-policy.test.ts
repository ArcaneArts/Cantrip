import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const appSource = await readFile(
  new URL("../src/app.ts", import.meta.url),
  "utf8",
);

function usageContexts(symbol: string): string[] {
  return [...appSource.matchAll(new RegExp(symbol, "gu"))]
    .slice(1)
    .map((match) =>
      appSource.slice(Math.max(0, match.index - 1_500), match.index + 200),
    );
}

describe("worker command timeout policy", () => {
  it("keeps finite control operations bounded", () => {
    expect(appSource).not.toMatch(/timeoutMs:\s*null/gu);
    expect(usageContexts("FINITE_WORKER_COMMAND_TIMEOUT_MS")).toHaveLength(15);
  });

  it("reserves the streaming timeout policy for turns and terminal sessions", () => {
    const contexts = usageContexts("STREAMING_WORKER_COMMAND_TIMEOUT_MS");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain('type: "chat.turn"');
    expect(contexts[1]).toContain('type: "terminal.open"');
  });
});
