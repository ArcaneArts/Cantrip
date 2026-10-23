import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
import { normalizeCodexThreadReadResponse } from "../src/codex/event-normalization.js";
import type {
  CodexThreadReadResponse,
  CodexThreadTurn,
} from "../src/codex/event-types.js";

const turn = (
  id: string,
  status: CodexThreadTurn["status"],
): CodexThreadTurn => ({
  id,
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: 1000,
  items: [],
});

describe("native lifecycle reconciliation", () => {
  it.each([
    ["active", [turn("previous", "failed")], "running"],
    ["idle", [turn("previous", "failed"), turn("latest", "completed")], "idle"],
    ["idle", [turn("latest", "failed")], "failed"],
    ["notLoaded", [turn("abandoned", "inProgress")], "idle"],
    ["systemError", [], "failed"],
  ] as const)(
    "observes %s without treating old turns as current",
    (type, turns, expected) => {
      const result = normalizeCodexThreadReadResponse(
        {
          thread: {
            id: "thread",
            status: { type },
            turns: [...turns],
          },
        },
        "/workspace",
      );
      expect(result.status).toBe(expected);
      expect(result.statusSource).toBe("native-thread");
    },
  );

  it("retains lifecycle for Cantrip turns omitted from external message import", async () => {
    const runtime = new CodexAppServer(
      "unused",
      "/unused",
      "/unused",
      unprobedCodexRuntimeReport,
    );
    const snapshot: CodexThreadReadResponse = {
      thread: {
        id: "thread",
        status: { type: "active" },
        turns: [
          {
            ...turn("own-turn", "inProgress"),
            items: [
              {
                type: "userMessage",
                id: "prompt",
                clientId: "cantrip:prompt",
                content: [],
              },
            ],
          },
        ],
      },
    };
    Object.assign(runtime, {
      ensureStarted: vi.fn(),
      request: vi.fn(async () => snapshot),
    });
    const options = {
      cwd: "/workspace",
      threadId: "thread",
      model: {},
      provider: {},
    } as Parameters<CodexAppServer["syncThread"]>[0];
    await runtime.prepareExternalSync(options);
    expect(await runtime.syncThread(options)).toMatchObject({
      status: "running",
      turns: [],
    });
    snapshot.thread.status.type = "idle";
    snapshot.thread.turns[0]!.status = "failed";
    expect(await runtime.syncThread(options)).toMatchObject({
      status: "failed",
      turns: [],
    });
    snapshot.thread.turns.push(turn("goal-continuation", "completed"));
    expect(await runtime.syncThread(options)).toMatchObject({ status: "idle" });
  });
});
