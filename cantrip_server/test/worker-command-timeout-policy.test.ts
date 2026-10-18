import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import { WorkerBridge } from "../src/workers/bridge.js";
import {
  FINITE_WORKER_COMMAND_TIMEOUT_MS,
  STREAMING_WORKER_COMMAND_TIMEOUT_MS,
} from "../src/app/shared/constants.js";

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
    // Durable handoffs and managed console preparation outlive an HTTP request.
    // Their explicit policies must not silently spread to unrelated controls.
    expect(
      appSources
        .filter(({ source }) => /timeoutMs:\s*null/u.test(source))
        .map(({ url }) => url.pathname.split("/").at(-1)),
    ).toEqual(["chat-runtime-handoffs.ts", "managed-chat-preparation.ts"]);
    expect(usageContexts("FINITE_WORKER_COMMAND_TIMEOUT_MS")).toHaveLength(18);
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

class PolicySocket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  sent: Array<string | Uint8Array> = [];
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

it("expires a finite command and releases its pending request at the deadline", async () => {
  vi.useFakeTimers();
  const bridge = new WorkerBridge();
  const socket = new PolicySocket();
  bridge.attach("timeout-worker", socket);
  try {
    const request = bridge.request(
      "timeout-worker",
      { type: "code.probe" },
      { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
    );
    const rejected = expect(request).rejects.toMatchObject({
      code: "worker-command-timeout",
    });
    await vi.advanceTimersByTimeAsync(FINITE_WORKER_COMMAND_TIMEOUT_MS - 1);
    expect(bridge.stats().activeRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(bridge.stats().activeRequests).toBe(0);
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});

it("keeps streaming work alive past the finite budget and releases it on actual completion", async () => {
  vi.useFakeTimers();
  const bridge = new WorkerBridge();
  const socket = new PolicySocket();
  bridge.attach("stream-worker", socket);
  const onEvent = vi.fn();
  try {
    const request = bridge.request(
      "stream-worker",
      { type: "code.probe" },
      { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS, onEvent },
    );
    const { requestId } = JSON.parse(String(socket.sent.at(-1)));
    await vi.advanceTimersByTimeAsync(FINITE_WORKER_COMMAND_TIMEOUT_MS + 1);
    expect(bridge.stats().activeRequests).toBe(1);
    socket.emit(
      "message",
      JSON.stringify({
        kind: "event",
        requestId,
        event: { type: "terminal.ready" },
      }),
      false,
    );
    socket.emit(
      "message",
      JSON.stringify({
        kind: "response",
        requestId,
        ok: true,
        result: { completed: true },
      }),
      false,
    );
    await expect(request).resolves.toEqual({ completed: true });
    expect(onEvent).toHaveBeenCalledWith({ type: "terminal.ready" });
    expect(bridge.stats().activeRequests).toBe(0);
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});
