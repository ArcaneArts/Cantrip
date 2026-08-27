import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function typescriptFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const nested = await Promise.all(
    entries.map((entry) => {
      const url = new URL(
        `${entry.name}${entry.isDirectory() ? "/" : ""}`,
        directory,
      );
      if (entry.isDirectory()) return typescriptFiles(url);
      return Promise.resolve(
        entry.isFile() && entry.name.endsWith(".ts") ? [url] : [],
      );
    }),
  );
  return nested
    .flat()
    .sort((left, right) => left.href.localeCompare(right.href));
}

const appSources = await Promise.all(
  [
    new URL("../src/app.ts", import.meta.url),
    ...(await typescriptFiles(new URL("../src/app/", import.meta.url))),
  ].map(async (url) => ({ source: await readFile(url, "utf8"), url })),
);
const combinedAppSource = appSources.map(({ source }) => source).join("\n");

function usageContexts(symbol: string): string[] {
  return appSources.flatMap(({ source }) =>
    [...source.matchAll(new RegExp(`timeoutMs:\\s*${symbol}\\b`, "gu"))].map(
      (match) =>
        source.slice(Math.max(0, match.index - 8_000), match.index + 200),
    ),
  );
}

describe("worker command timeout policy", () => {
  it("keeps finite control operations bounded", () => {
    expect(combinedAppSource).not.toMatch(/timeoutMs:\s*null/gu);
    expect(usageContexts("FINITE_WORKER_COMMAND_TIMEOUT_MS")).toHaveLength(20);
  });

  it("reserves the unbounded policy for streaming and safe-boundary commands", () => {
    const contexts = usageContexts("STREAMING_WORKER_COMMAND_TIMEOUT_MS");
    expect(contexts).toHaveLength(10);
    expect(
      contexts.filter((context) => context.includes('type: "chat.turn"')),
    ).toHaveLength(1);
    expect(
      contexts.filter((context) => context.includes('type: "terminal.open"')),
    ).toHaveLength(3);
    expect(
      contexts.filter((context) => context.includes('type: "chat.pause.set"')),
    ).toHaveLength(6);
  });
});
