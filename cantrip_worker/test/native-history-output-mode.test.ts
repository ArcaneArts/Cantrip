import { describe, expect, it, vi } from "vitest";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import { createNativeHistoryOutputModeResolver } from "../src/native-history-output-mode.js";

const identity = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  component: "assistant",
  identityKind: "canonical",
} as const;
const context = {
  cwd: "/original",
  model: "model",
  collaborationMode: "plan",
  reasoningEffort: null,
  rootTurnId: null,
};
function snapshot(contexts: (typeof context)[]) {
  return parseCodexNativeHistory(
    {
      thread: { id: "thread", turns: [], status: { type: "idle" } },
      history: {
        version: 1,
        currentTurnId: "turn",
        currentTurnState: "live",
        turns: [
          {
            turnId: "turn",
            source: "canonical",
            retention: "partial",
            contexts,
            items: [],
            usage: null,
            warnings: null,
            errors: null,
          },
        ],
      },
    },
    "thread",
  );
}
function fixture() {
  const observations = new NativeHistoryObservations();
  observations.replace("native-1");
  let contexts: (typeof context)[] = [];
  const read = vi.fn(async () => snapshot(contexts));
  const subscriptions: Array<ReturnType<typeof observations.subscribe>> = [];
  const mode = createNativeHistoryOutputModeResolver(
    read,
    (thread, observer) => {
      const subscription = observations.subscribe(thread, observer, read);
      vi.spyOn(subscription, "close");
      subscriptions.push(subscription);
      return subscription;
    },
  );
  return {
    observations,
    read,
    subscriptions,
    mode,
    retain: (value = [context]) => {
      contexts = value;
    },
  };
}

describe("original native output mode observation", () => {
  it("retains ordered publication until original context arrives, then caches its mode", async () => {
    const f = fixture(),
      completed = vi.fn();
    const pending = f.mode(identity).then((mode) => {
      completed(mode);
      return mode;
    });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
    f.retain();
    f.observations.notification("item/completed", { threadId: "thread" });
    await expect(pending).resolves.toBe("plan");
    await expect(f.mode(identity)).resolves.toBe("plan");
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.subscriptions[0]!.close).toHaveBeenCalledOnce();
  });

  it("does not lose a history change arriving during an incomplete snapshot read", async () => {
    const f = fixture();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.read.mockImplementationOnce(async () => {
      await held;
      return snapshot([]);
    });
    const pending = f.mode(identity);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.retain();
    f.observations.notification("turn/completed", { threadId: "thread" });
    finish();
    await expect(pending).resolves.toBe("plan");
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("releases a pending publication observer on actual transport replacement", async () => {
    const f = fixture();
    const pending = f.mode(identity);
    const rejected = expect(pending).rejects.toThrow("replaced or closed");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.observations.replace("native-2");
    await rejected;
    expect(f.subscriptions[0]!.close).toHaveBeenCalledOnce();
  });

  it("rejects conflicting retained contexts rather than waiting or choosing current settings", async () => {
    const f = fixture();
    f.retain([context, { ...context, cwd: "/another" }]);
    await expect(f.mode(identity)).rejects.toThrow(
      "disagree on presentation scope",
    );
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.subscriptions[0]!.close).toHaveBeenCalledOnce();
  });

  it("releases a pending publication when the actual native thread closes", async () => {
    const f = fixture();
    const pending = f.mode(identity);
    const rejected = expect(pending).rejects.toThrow("Native thread closed");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.observations.notification("thread/closed", { threadId: "thread" });
    await rejected;
    expect(f.subscriptions[0]!.close).toHaveBeenCalledOnce();
  });
});
