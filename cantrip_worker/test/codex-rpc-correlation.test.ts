import { afterEach, describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import {
  CodexAppServer,
  CodexNativeRpcError,
  type RpcMessage,
} from "../src/codex/app-server.js";

interface RuntimeRpcMethods {
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  send(message: RpcMessage): void;
  handleMessage(data: Buffer): void;
}

const runtimes: CodexAppServer[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(unavailableMethod?: string) {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    {
      ...unprobedCodexRuntimeReport,
      methods: {
        ...unprobedCodexRuntimeReport.methods,
        ...(unavailableMethod
          ? { [unavailableMethod]: "unavailable" as const }
          : {}),
      },
    },
  );
  runtimes.push(runtime);
  const rpc = runtime as unknown as RuntimeRpcMethods;
  const sent: RpcMessage[] = [];
  vi.spyOn(rpc, "send").mockImplementation((message) => {
    sent.push(message);
  });
  return {
    runtime,
    rpc,
    sent,
    deliver: (message: RpcMessage) =>
      rpc.handleMessage(Buffer.from(JSON.stringify(message))),
  };
}

describe("Codex runtime RPC correlation", () => {
  it("resolves concurrent responses in reverse order, including string IDs", async () => {
    const f = fixture();
    const first = f.rpc.request("thread/read", { threadId: "one" });
    const second = f.rpc.request("thread/list", {});
    expect(f.sent.map((message) => message.id)).toEqual([1, 2]);
    f.deliver({ id: "2", result: { data: ["second"] } });
    await expect(second).resolves.toEqual({ data: ["second"] });
    f.deliver({ id: 1, result: { thread: "first" } });
    await expect(first).resolves.toEqual({ thread: "first" });
  });

  it("preserves native error details and the request method", async () => {
    const f = fixture();
    const pending = f.rpc.request("thread/settings/read", {});
    const error = {
      code: -32000,
      message: "settings rejected",
      data: { reason: "conflict" },
    };
    f.deliver({ id: 1, error });
    await expect(pending).rejects.toBeInstanceOf(CodexNativeRpcError);
    await expect(pending).rejects.toMatchObject({
      nativeError: error,
      requestMethod: "thread/settings/read",
    });
  });

  it("keeps private inference responses out of diagnostics without changing caller results", async () => {
    const f = fixture();
    const pending = f.rpc.request("cantrip/inference", { input: "synthetic" });
    const result = { text: "protected-inference-output" };
    f.deliver({ id: "1", result });
    await expect(pending).resolves.toEqual(result);
    expect(f.runtime.diagnostics()).toHaveLength(1);
    expect(f.runtime.diagnostics()[0]?.payload).toEqual({
      id: "1",
      privateInference: true,
      status: "completed",
    });
    expect(JSON.stringify(f.runtime.diagnostics())).not.toContain(result.text);
  });

  it("records unknown and duplicate responses without settling another request", async () => {
    const f = fixture();
    const pending = f.rpc.request("thread/read", {});
    f.deliver({ id: 99, result: "unknown" });
    f.deliver({ id: 1, result: "expected" });
    f.deliver({ id: "1", result: "duplicate" });
    await expect(pending).resolves.toBe("expected");
    expect(
      f.runtime
        .diagnostics()
        .filter((event) => event.kind === "unmatched-response")
        .map((event) => event.payload),
    ).toEqual([
      { id: 99, result: "unknown" },
      { id: "1", result: "duplicate" },
    ]);
  });

  it("times out a request and treats its late response as unmatched", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.rpc.request("thread/read", {}, 50);
    const rejected = expect(pending).rejects.toThrow(
      "Codex request thread/read timed out.",
    );
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    f.deliver({ id: 1, result: "late" });
    expect(f.runtime.diagnostics().at(-1)).toMatchObject({
      kind: "unmatched-response",
      payload: { id: 1, result: "late" },
    });
  });

  it("redacts a private response arriving after its request has timed out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.rpc.request("cantrip/inference", {}, 50);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    f.deliver({ id: "1", result: { text: "late-protected-output" } });
    expect(f.runtime.diagnostics().map((event) => event.payload)).toEqual([
      { id: "1", privateInference: true, status: "completed" },
      { id: "1", privateInference: true, status: "completed" },
    ]);
    expect(JSON.stringify(f.runtime.diagnostics())).not.toContain(
      "late-protected-output",
    );
  });

  it("rejects every pending request on close and retains monotonic request IDs", async () => {
    const f = fixture();
    const first = expect(f.rpc.request("thread/read", {})).rejects.toThrow(
      "Codex app-server stopped.",
    );
    const second = expect(f.rpc.request("thread/list", {})).rejects.toThrow(
      "Codex app-server stopped.",
    );
    f.runtime.close();
    await Promise.all([first, second]);
    const next = f.rpc.request("thread/read", {});
    expect(f.sent.map((message) => message.id)).toEqual([1, 2, 3]);
    f.deliver({ id: 3, result: "replacement" });
    await expect(next).resolves.toBe("replacement");
  });

  it("rejects unavailable methods before sending or allocating a request ID", async () => {
    const f = fixture("thread/read");
    await expect(f.rpc.request("thread/read", {})).rejects.toThrow(
      "method thread/read is unavailable",
    );
    expect(f.sent).toEqual([]);
    const available = f.rpc.request("thread/list", {});
    expect(f.sent[0]?.id).toBe(1);
    f.deliver({ id: 1, result: [] });
    await expect(available).resolves.toEqual([]);
  });
});
