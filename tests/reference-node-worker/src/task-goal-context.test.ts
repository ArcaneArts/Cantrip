import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeTaskGoalContext } from "./task-goal-context.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const codexHome = await mkdtemp(path.join(tmpdir(), "cantrip-goal-context-"));
  directories.push(codexHome);
  return {
    chatId: "chat-goal-context",
    threadId: "thread-goal-context",
    codexHome,
    objective: "Implement the approved plan completely.",
    implementationContext:
      "# Complete approved plan\n" + "milestone\n".repeat(2_000),
  };
}

function referencedFile(objective: string): string {
  const reference = /plan at (".*") before making changes/u.exec(
    objective,
  )?.[1];
  if (!reference) throw new Error("Missing durable plan reference.");
  return JSON.parse(reference) as string;
}

describe("Task Goal implementation context", () => {
  it("keeps the whole plan durable, private, and stable across retries", async () => {
    const input = await fixture();
    const objective = await materializeTaskGoalContext(input);
    expect(objective).toContain(input.objective);
    expect(Array.from(objective).length).toBeLessThanOrEqual(4_000);
    const file = referencedFile(objective);
    expect(await readFile(file, "utf8")).toBe(input.implementationContext);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    expect(await materializeTaskGoalContext(input)).toBe(objective);
  });

  it("recovers legacy oversized objectives without truncating their implementation context", async () => {
    const input = await fixture();
    input.objective = input.implementationContext;
    const objective = await materializeTaskGoalContext(input);
    expect(Array.from(objective).length).toBeLessThanOrEqual(4_000);
    expect(await readFile(referencedFile(objective), "utf8")).toBe(
      input.implementationContext,
    );
  });

  it("rejects an actually changed saved plan instead of silently replacing it", async () => {
    const input = await fixture();
    const file = referencedFile(await materializeTaskGoalContext(input));
    await writeFile(file, "changed plan", "utf8");
    await expect(materializeTaskGoalContext(input)).rejects.toThrow(
      "has changed",
    );
    expect(await readFile(file, "utf8")).toBe("changed plan");
  });
});
