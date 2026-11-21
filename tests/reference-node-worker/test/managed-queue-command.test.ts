import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  managedQueueNativeCommand,
  managedQueueTurnInput,
} from "../src/codex/managed-queue-command.js";
import type { ManagedQueueNativeInput } from "../src/managed-queue-input.js";

function opened(
  text: string,
  action: ManagedQueueNativeInput["action"],
  executionMethod: ManagedQueueNativeInput["executionMethod"],
): ManagedQueueNativeInput {
  return {
    version: 1,
    input: [{ type: "text", text }],
    displayText: text,
    action,
    executionMethod,
    attachmentMap: [],
  };
}
const command = (input: ManagedQueueNativeInput) =>
  managedQueueNativeCommand({
    opened: input,
    threadId: "thread",
    promptId: "prompt",
    codexHome: "/tmp/unused-queue-command",
  });

describe("queued native command conversion", () => {
  it("preserves literal vectors and removes only /plan UI syntax with native byte-range adjustment", () => {
    const input = opened("/plan 😀 inspect", "parseSlash", "turn/start");
    input.input = [
      {
        type: "text",
        text: input.displayText,
        text_elements: [
          { byteRange: { start: 11, end: 18 }, placeholder: "inspect" },
        ],
      },
      { type: "mention", name: "reviewer", path: "agent://reviewer" },
    ];
    const result = managedQueueTurnInput(input);
    expect(result).toEqual([
      {
        type: "text",
        text: "😀 inspect",
        text_elements: [
          { byteRange: { start: 5, end: 12 }, placeholder: "inspect" },
        ],
      },
      input.input[1],
    ]);
    expect(input.input[0]).toMatchObject({ text: "/plan 😀 inspect" });
    input.action = "literal";
    expect(managedQueueTurnInput(input)).toEqual(input.input);
  });

  it("keeps shell quoting and redirects verbatim and maps bare plan to settings", async () => {
    expect(
      await command(
        opened(
          "!printf '%s' 'a b' | cat > out",
          "runShell",
          "thread/shellCommand",
        ),
      ),
    ).toEqual({
      method: "thread/shellCommand",
      params: { threadId: "thread", command: "printf '%s' 'a b' | cat > out" },
    });
    expect(
      await command(opened("/plan", "parseSlash", "thread/settings/update")),
    ).toEqual({
      method: "thread/settings/update",
      params: { threadId: "thread" },
      planMode: "plan",
    });
  });

  it.each([
    ["clear", "thread/goal/clear", {}],
    ["PAUSE", "thread/goal/set", { status: "paused" }],
    ["resume", "thread/goal/set", { status: "active" }],
  ] as const)(
    "maps goal %s as an actual control",
    async (argument, method, params) => {
      expect(
        await command(opened(`/goal ${argument}`, "parseSlash", method)),
      ).toEqual({ method, params: { threadId: "thread", ...params } });
    },
  );

  it("treats goal text as an objective without inventing inline budget syntax", async () => {
    expect(
      await command(
        opened(
          "/goal 100 tokens inspect the tree",
          "parseSlash",
          "thread/goal/set",
        ),
      ),
    ).toEqual({
      method: "thread/goal/set",
      params: { threadId: "thread", objective: "100 tokens inspect the tree" },
    });
    await expect(
      command(opened("/goal edit", "parseSlash", "thread/goal/set")),
    ).rejects.toThrow("interactive CLI view");
  });

  it("materializes rich and long objectives into immutable account-owned input files", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "queue-goal-"));
    try {
      const input = opened("😀".repeat(4001), "literal", "thread/goal/set");
      input.input.push({
        type: "image",
        url: "data:image/png;base64,cGl4ZWxz",
      });
      const result = await managedQueueNativeCommand({
        opened: input,
        threadId: "thread",
        promptId: "prompt",
        codexHome,
      });
      const objective = String(result.params.objective);
      const file = objective.slice(
        "Read the Codex goal objective file at ".length,
        -" before continuing.".length,
      );
      expect(file.startsWith(path.join(codexHome, "attachments"))).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).toContain("😀".repeat(4001));
      expect(
        await readFile(path.join(path.dirname(file), "image-1.png"), "utf8"),
      ).toBe("pixels");
      expect(
        (
          await managedQueueNativeCommand({
            opened: input,
            threadId: "thread",
            promptId: "prompt",
            codexHome,
          })
        ).params.objective,
      ).toBe(objective);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
