import { once } from "node:events";
import WebSocket from "ws";
import { expect, vi } from "vitest";
import type { CodexAppServer } from "../src/codex/app-server.js";
import type { HandoffRuntime } from "../src/codex/managed-runtime-handoff.js";

type Frame = Record<string, any>;

/** Seed only the isolated native conversation through actual RPC and fake-provider
 * output. No source rollout or native database is fabricated. */
export async function seedHandoffHistory(
  runtime: CodexAppServer,
  configuration: HandoffRuntime["configuration"],
  threadId: string,
) {
  const socket = new WebSocket(
    await runtime.remoteEndpoint(configuration.model, configuration.provider),
  );
  await once(socket, "open");
  const frames: Frame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  let sequence = 0;
  const request = async (method: string, params: Frame) => {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(
      () => expect(frames.some((frame) => frame.id === id)).toBe(true),
      { timeout: 15000 },
    );
    const response = frames.find((frame) => frame.id === id)!;
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result as Frame;
  };
  try {
    await request("initialize", {
      clientInfo: { name: "handoff-history-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    await request("thread/resume", { threadId });
    const goal = await request("thread/goal/set", {
      threadId,
      objective: "Retain the handoff fixture goal",
      tokenBudget: 1000,
      status: "paused",
    });
    const started = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Remember HANDOFF_HISTORY_SENTINEL" }],
    });
    await vi.waitFor(
      () =>
        expect(
          frames.find(
            (frame) =>
              frame.method === "turn/completed" &&
              frame.params?.turn?.id === started.turn.id,
          )?.params.turn.status,
        ).toBe("completed"),
      { timeout: 15000 },
    );
    const history = await runtime.readNativeHistory(threadId);
    expect(history.thread.turns).toHaveLength(1);
    expect(JSON.stringify(history)).toContain("HANDOFF_HISTORY_SENTINEL");
    expect(JSON.stringify(history)).toContain("Retained fixture answer");
    expect(goal.goal.status).toBe("paused");
    return {
      history,
      goal: await runtime.getGoal({ ...configuration, threadId }),
    };
  } finally {
    const closed = once(socket, "close");
    socket.terminate();
    await closed;
  }
}
