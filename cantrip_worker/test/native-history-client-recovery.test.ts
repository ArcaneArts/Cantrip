import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHistoryClient } from "../src/native-history-client.js";

const binding = {
  id: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  projectId: "project",
  worktreeId: "tree",
  modelRouteId: null,
  providerAccountId: null,
  createdFromOperationId: "root",
  createdAt: "2026-11-07T00:00:00.000Z",
};
const identity = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  component: "assistant",
  identityKind: "canonical" as const,
};
const mapping = {
  identity,
  key: "a".repeat(64),
  messageId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "original-item",
  preservedInput: null,
};
function invoke(
  client: NativeHistoryClient,
  action: "open" | "resolve",
  signal?: AbortSignal,
) {
  return action === "open"
    ? client.open(
        {
          chatId: "chat",
          threadId: "thread",
          provenance: {
            kind: "command",
            operationId: "root",
            operationGeneration: "original",
          },
        },
        signal,
      )
    : client.resolve(
        {
          chatId: "chat",
          bindingId: "binding",
          items: [{ identity, association: { kind: "output" } }],
        },
        signal,
      );
}
describe("native history metadata recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["open", "resolve"] as const)(
    "retries the same %s identity after temporary server unavailability",
    async (action) => {
      vi.useFakeTimers();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ error: "Temporary outage" }, { status: 503 }),
        )
        .mockResolvedValueOnce(
          Response.json(action === "open" ? { binding } : { items: [mapping] }),
        );
      const client = new NativeHistoryClient({
        serverUrl: "http://127.0.0.1:4310",
        workerId: "worker",
        token: () => "credential",
        fetch: fetcher,
      });
      const pending = invoke(client, action);
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toEqual(action === "open" ? binding : [mapping]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]![1]!.body).toBe(
        fetcher.mock.calls[1]![1]!.body,
      );
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
        Array(2).fill(
          `http://127.0.0.1:4310/api/internal/native-history/${action}`,
        ),
      );
    },
  );
  it.each(["open", "resolve"] as const)(
    "preserves a permanent %s authority rejection",
    async (action) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "foreign-binding" }, { status: 409 }),
        );
      const client = new NativeHistoryClient({
        serverUrl: "http://127.0.0.1:4310",
        workerId: "worker",
        token: () => "credential",
        fetch: fetcher,
      });
      await expect(invoke(client, action)).rejects.toMatchObject({
        status: 409,
        code: "foreign-binding",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a successful response that substitutes another canonical item without retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [{ ...mapping, identity: { ...identity, itemId: "other" } }],
      }),
    );
    const client = new NativeHistoryClient({
      serverUrl: "http://127.0.0.1:4310",
      workerId: "worker",
      token: () => "credential",
      fetch: fetcher,
    });
    await expect(invoke(client, "resolve")).rejects.toThrow(
      "unrelated item mappings",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
