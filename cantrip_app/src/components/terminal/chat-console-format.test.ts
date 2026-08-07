import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { formatConsoleMessage, markdownToAnsi } from "./chat-console-format";

function message(
  role: ChatMessage["role"],
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id: "message-1",
    chatId: "chat-1",
    sequence: 1,
    role,
    content,
    createdAt: "2026-08-07T12:00:00.000Z",
  };
}

describe("linked Codex console formatting", () => {
  it("renders Markdown structure as ANSI terminal styling", () => {
    const formatted = markdownToAnsi(
      "## Result\n\n- **Built** `app.ts`\n\n[Open](https://cantrip.art)",
    );

    expect(formatted).toContain("\x1b[1m\x1b[96mResult");
    expect(formatted).toContain("\x1b[36m•\x1b[0m");
    expect(formatted).toContain("\x1b[1mBuilt\x1b[0m");
    expect(formatted).toContain("\x1b[33mapp.ts\x1b[0m");
    expect(formatted).toContain("\x1b[4m\x1b[96mOpen\x1b[0m");
    expect(formatted).not.toContain("## Result");
    expect(formatted).not.toContain("**Built**");
  });

  it("colors completed commands and file changes by state", () => {
    const command = formatConsoleMessage(
      message("assistant", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm check",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
    );
    const files = formatConsoleMessage(
      message("assistant", [
        {
          type: "activity",
          activity: {
            type: "fileChange",
            id: "files-1",
            status: "completed",
            changes: [
              { kind: "add", path: "new.ts" },
              { kind: "update", path: "app.ts" },
              { kind: "delete", path: "old.ts" },
            ],
          },
        },
      ]),
    );

    expect(command).toContain("\x1b[32m✓\x1b[0m");
    expect(command).toContain("Ran\x1b[0m pnpm check");
    expect(files).toContain("\x1b[32mAdded\x1b[0m new.ts");
    expect(files).toContain("\x1b[33mEdited\x1b[0m app.ts");
    expect(files).toContain("\x1b[31mDeleted\x1b[0m old.ts");
  });

  it("does not allow stored messages to inject terminal control sequences", () => {
    const formatted = formatConsoleMessage(
      message("assistant", [{ type: "text", text: "safe\x1b[2Jstill safe" }]),
    );

    expect(formatted).toContain("safestill safe");
    expect(formatted).not.toContain("\x1b[2J");
  });
});
