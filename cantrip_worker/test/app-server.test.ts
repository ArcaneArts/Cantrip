import { describe, expect, it } from "vitest";

import {
  CANTRIP_WORKTREE_DYNAMIC_TOOLS,
  changedFiles,
  codexEndpointFromLine,
  codexModelProviderName,
  codexWorktreeTurnPolicy,
  codexWorkspaceContext,
  executeDynamicWorktreeTool,
  GOAL_CONTINUATION_PROMPT,
  goalShouldContinue,
  parseCodexSkills,
} from "../src/codex/app-server.js";

describe("Cantrip dynamic worktree tools", () => {
  it("advertises all lifecycle operations with strict object schemas", () => {
    expect(CANTRIP_WORKTREE_DYNAMIC_TOOLS.map(({ name }) => name)).toEqual([
      "cantrip_worktrees_list",
      "cantrip_worktree_create",
      "cantrip_worktree_acquire",
      "cantrip_worktree_switch",
      "cantrip_worktree_status",
      "cantrip_worktree_release",
      "cantrip_worktree_remove",
    ]);
    expect(
      CANTRIP_WORKTREE_DYNAMIC_TOOLS.every(
        ({ inputSchema }) => inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
  });

  it("returns structured dynamic-tool results and isolates handler errors", async () => {
    const params = {
      arguments: { worktreeId: "worktree-2" },
      callId: "call-1",
      threadId: "thread-1",
      tool: "cantrip_worktree_switch",
      turnId: "turn-1",
    };
    await expect(
      executeDynamicWorktreeTool(
        async (input) => ({
          summary: `Scheduled ${String(input.arguments.worktreeId)}`,
          worktreeId: "worktree-2",
          continuationScheduled: true,
        }),
        params,
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("worktree-2"),
        },
      ],
    });
    await expect(
      executeDynamicWorktreeTool(async () => {
        throw new Error("unsafe transition");
      }, params),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "unsafe transition" }],
    });
  });
});

describe("codexWorkspaceContext", () => {
  it("binds every app-server operation to one resolved worktree root", () => {
    expect(codexWorkspaceContext("/tmp/project/../project/worktree")).toEqual({
      cwd: "/tmp/project/worktree",
      runtimeWorkspaceRoots: ["/tmp/project/worktree"],
    });
  });
});

describe("codexWorktreeTurnPolicy", () => {
  it("enforces inspection-only Primary for required-for-writes projects", () => {
    expect(
      codexWorktreeTurnPolicy({
        cwd: "/workspace/project",
        isPrimary: true,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
      }),
    ).toEqual({
      additionalContext: {
        "cantrip.worktree-policy": {
          kind: "application",
          value: expect.stringContaining("Primary is inspection-only"),
        },
      },
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("grants checkout-scoped writes outside Primary and explains pinned mode", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project/../project/feature",
      isPrimary: false,
      worktreeMode: "pinned",
      worktreePolicy: "required-for-writes",
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/project/feature"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(policy.additionalContext["cantrip.worktree-policy"].value).toContain(
      "pinned to the current worktree",
    );
  });
});

describe("changedFiles", () => {
  it("summarizes added, updated, and deleted files from a turn diff", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
    ].join("\n");

    expect(changedFiles(diff)).toEqual([
      { path: "README.md", kind: "update" },
      { path: "src/new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ]);
  });
});

describe("codexModelProviderName", () => {
  it("uses Codex's built-in OpenAI provider for ChatGPT accounts", () => {
    expect(
      codexModelProviderName({
        id: "personal-chatgpt",
        name: "Personal ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      }),
    ).toBe("openai");
  });
});

describe("codexEndpointFromLine", () => {
  it("recognizes both plain and colored Codex endpoint announcements", () => {
    expect(codexEndpointFromLine("  listening on: ws://127.0.0.1:54321")).toBe(
      "ws://127.0.0.1:54321",
    );
    expect(
      codexEndpointFromLine(
        "  \u001b[2mlistening on:\u001b[0m \u001b[32mws://127.0.0.1:54321\u001b[0m",
      ),
    ).toBe("ws://127.0.0.1:54321");
  });
});

describe("parseCodexSkills", () => {
  it("returns enabled skills for the requested working directory", () => {
    expect(
      parseCodexSkills(
        {
          data: [
            {
              cwd: "/workspace",
              skills: [
                {
                  name: "skill-creator",
                  description: "Create reusable skills",
                  path: "/skills/skill-creator/SKILL.md",
                  enabled: true,
                  interface: { displayName: "Skill Creator" },
                },
                {
                  name: "disabled",
                  description: "Disabled",
                  path: "/skills/disabled/SKILL.md",
                  enabled: false,
                },
              ],
            },
          ],
        },
        "/workspace",
      ),
    ).toEqual([
      {
        name: "skill-creator",
        description: "Create reusable skills",
        displayName: "Skill Creator",
        path: "/skills/skill-creator/SKILL.md",
      },
    ]);
  });
});

describe("Codex goals", () => {
  const goal = {
    threadId: "thread-1",
    objective: "Complete the task",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 2,
  };

  it("continues only active goals with an explicit follow-up prompt", () => {
    expect(goalShouldContinue(goal)).toBe(true);
    expect(goalShouldContinue({ ...goal, status: "paused" })).toBe(false);
    expect(goalShouldContinue({ ...goal, status: "complete" })).toBe(false);
    expect(GOAL_CONTINUATION_PROMPT).toContain("active goal");
  });
});
