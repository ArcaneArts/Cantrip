import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  CodexNativeRpcError,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { WebSocketServer } from "ws";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nativeHistoryUserMessage,
  nativeHistoryCursorSchema,
  parseCodexNativeHistory,
  readCodexNativeHistory,
} from "../src/codex/native-history.js";

const usage = {
  totalTokens: 13,
  inputTokens: 10,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 0,
  outputTokens: 3,
  reasoningOutputTokens: 1,
};

it("validates native cursor strings without rounding or throwing outside schema errors", () => {
  const cursor = {
    epoch: "native",
    sequence: "18446744073709551615",
    previousSequence: "9007199254740993",
  };
  expect(nativeHistoryCursorSchema.parse(cursor)).toEqual(cursor);
  for (const sequence of [
    "18446744073709551616",
    "-1",
    "1.5",
    "abc",
    "01",
    "9".repeat(1000),
  ])
    expect(
      nativeHistoryCursorSchema.safeParse({ ...cursor, sequence }).success,
    ).toBe(false);
});
const response = () => ({
  thread: {
    id: "root",
    status: { type: "idle" },
    parentThreadId: null,
    forkedFromId: "source-thread",
    turns: [
      {
        id: "turn",
        status: "completed",
        itemsView: "full",
        startedAt: null,
        completedAt: 2,
        durationMs: null,
        items: [
          {
            id: "user",
            type: "userMessage",
            clientId: "cantrip:canonical-message",
            content: [
              {
                type: "image",
                url: "data:image/png;base64,cG5n",
                detail: null,
              },
              { type: "localAudio", path: "/account/audio.wav" },
              { type: "mention", name: "source", path: "app://source" },
            ],
          },
          {
            id: "one",
            type: "agentMessage",
            text: "Identical",
            phase: "commentary",
            memoryCitation: { citations: [] },
          },
          {
            id: "two",
            type: "agentMessage",
            text: "Identical",
            phase: "commentary",
          },
          {
            id: "tool",
            type: "dynamicToolCall",
            arguments: { private: "argument" },
            contentItems: [{ type: "inputText", text: "full result" }],
            status: "completed",
          },
          {
            id: "future",
            type: "futureTool",
            nested: { nullable: null, value: [1, true] },
          },
        ],
      },
    ],
  },
  history: {
    version: 1,
    currentTurnId: null,
    currentTurnState: "live",
    turns: [
      {
        turnId: "turn",
        source: "canonical",
        retention: "complete",
        items: [
          {
            itemId: "user",
            state: "completed",
            startedAtMs: null,
            completedAtMs: 123,
          },
        ],
        usage: {
          responses: [
            {
              responseId: "response",
              threadId: "root",
              sessionId: "native-session",
              rootTurnId: "turn",
              usage,
            },
          ],
          total: usage,
          conflictingResponseIds: [],
        },
        warnings: [],
        errors: [],
      },
    ],
  },
});

describe("worker-local native history", () => {
  it("retains exact turn contexts without replacing them with current thread settings", () => {
    const value = response();
    const contexts = [
      {
        cwd: "/old",
        model: "old-model",
        collaborationMode: "plan",
        reasoningEffort: "high",
        rootTurnId: "original-root",
      },
      {
        cwd: "/compacted",
        model: "new-model",
        collaborationMode: null,
        reasoningEffort: null,
        rootTurnId: "original-root",
      },
    ];
    const extended = {
      ...value,
      thread: { ...value.thread, cwd: "/current", model: "current-model" },
      history: {
        ...value.history,
        turns: [{ ...value.history.turns[0], contexts }],
      },
    };
    expect(
      parseCodexNativeHistory(extended, "root").history!.turns[0]!.contexts,
    ).toEqual(contexts);
    expect(
      parseCodexNativeHistory(value, "root").history!.turns[0]!.contexts,
    ).toBeUndefined();
    extended.history.turns[0]!.contexts = [];
    expect(
      parseCodexNativeHistory(extended, "root").history!.turns[0]!.contexts,
    ).toEqual([]);
    extended.history.turns[0]!.contexts = [{ ...contexts[0]!, cwd: "" }];
    expect(() => parseCodexNativeHistory(extended, "root")).toThrow();
  });

  it("keeps incomplete retention and conflicting measured usage distinct from unavailable data", () => {
    const raw = response();
    const turn = raw.history.turns[0]!;
    const conflicted = {
      ...raw,
      history: {
        ...raw.history,
        turns: [
          {
            ...turn,
            retention: "partial",
            warnings: null,
            errors: [
              {
                message: "Interrupted",
                codexErrorInfo: null,
                additionalDetails: null,
                misalignment: null,
              },
            ],
            usage: {
              ...turn.usage,
              total: null,
              conflictingResponseIds: ["response"],
              responses: [
                ...turn.usage.responses,
                {
                  ...turn.usage.responses[0]!,
                  usage: { ...usage, totalTokens: 14 },
                },
              ],
            },
          },
        ],
      },
    };
    expect(parseCodexNativeHistory(conflicted, "root")).toEqual(conflicted);
  });

  it("rejects a delayed history result after actual transport replacement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-history-transport-"),
    );
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== undefined)
          socket.send(
            JSON.stringify({
              id: frame.id,
              result: frame.method === "thread/read" ? response() : {},
            }),
          );
      }),
    );
    const children: ChildProcessWithoutNullStreams[] = [];
    const launch: CodexProcessLauncher = () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(`listening on: ${url}\n`)});setInterval(()=>{},1000);`,
        ],
        { stdio: "pipe" },
      );
      children.push(child);
      return child;
    };
    const runtime = new CodexAppServer(
      "fixture",
      directory,
      path.join(directory, "home"),
      {
        ...unprobedCodexRuntimeReport,
        compatibility: "compatible",
        degradedReasons: [],
        initialize: {
          experimentalApi: true,
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "codex_cli_rs/0.153.4",
        },
      },
      undefined,
      undefined,
      undefined,
      launch,
    );
    const model = { id: "model", name: "gpt-5", reasoningEffort: null };
    const provider = {
      id: "provider",
      name: "fixture",
      kind: "openai-compatible" as const,
      baseUrl: "https://example.test/v1",
      apiKey: null,
    };
    try {
      await runtime.remoteEndpoint(model, provider);
      const previous = runtime.transportGeneration;
      expect(previous).toBeTruthy();
      const native = runtime as unknown as {
        request(method: string, params: unknown): Promise<unknown>;
      };
      const original = native.request.bind(runtime);
      let resolve!: (value: unknown) => void;
      const delayed = new Promise<unknown>((yes) => {
        resolve = yes;
      });
      let delay = true;
      vi.spyOn(native, "request").mockImplementation((method, params) => {
        if (method === "thread/read" && delay) {
          delay = false;
          return delayed;
        }
        return original(method, params);
      });
      const pending = runtime.readNativeHistory("root").catch((error) => error);
      runtime.close();
      await runtime.remoteEndpoint(model, provider);
      expect(runtime.transportGeneration).toBeTruthy();
      expect(runtime.transportGeneration).not.toBe(previous);
      resolve(response());
      expect(await pending).toMatchObject({
        message: "The native history transport changed during the read.",
      });
      await expect(runtime.readNativeHistory("root")).resolves.toEqual(
        response(),
      );
    } finally {
      runtime.close();
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, "close");
        child.kill("SIGTERM");
        await exited;
      }
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves exact rich payloads, attachment-only input and distinct identical messages", () => {
    const raw = response();
    const parsed = parseCodexNativeHistory(raw, "root");
    expect(parsed).toEqual(raw);
    expect(parsed.thread.turns[0]!.items.map((item) => item.id)).toEqual([
      "user",
      "one",
      "two",
      "tool",
      "future",
    ]);
    expect(nativeHistoryUserMessage(parsed.thread.turns[0]!.items[0]!)).toEqual(
      raw.thread.turns[0]!.items[0],
    );
    expect(
      nativeHistoryUserMessage(parsed.thread.turns[0]!.items[1]!),
    ).toBeNull();
    expect(parsed.history!.turns[0]!.items[0]!.startedAtMs).toBeNull();
  });

  it("keeps old metadata unavailable and legacy identifiers unchanged", () => {
    const raw = response();
    raw.history.turns[0]!.source = "legacy";
    raw.thread.turns[0]!.items[0]!.id = "item-1";
    expect(parseCodexNativeHistory(raw, "root").history!.turns[0]!.source).toBe(
      "legacy",
    );
    const { history: _history, ...older } = raw;
    const parsed = parseCodexNativeHistory(older, "root");
    expect(parsed.history).toBeNull();
    expect(parsed.thread.turns[0]!.items[0]!.id).toBe("item-1");
  });

  it("reads actual native metadata without preparation or synthetic execution", async () => {
    const request = vi.fn().mockResolvedValue(response());
    await expect(readCodexNativeHistory(request, "root")).resolves.toEqual(
      response(),
    );
    expect(request.mock.calls).toEqual([
      [
        "thread/read",
        { threadId: "root", includeTurns: true, includeHistoryMetadata: true },
      ],
    ]);
  });

  it("falls back only after an actual unsupported metadata field error", async () => {
    const { history: _history, ...older } = response();
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new CodexNativeRpcError(
          "unsupported",
          { code: -32602, message: "unknown field `includeHistoryMetadata`" },
          "thread/read",
        ),
      )
      .mockResolvedValueOnce(older);
    expect((await readCodexNativeHistory(request, "root")).history).toBeNull();
    expect(request.mock.calls[1]).toEqual([
      "thread/read",
      { threadId: "root", includeTurns: true },
    ]);
    const failed = vi
      .fn()
      .mockRejectedValue(
        new CodexNativeRpcError(
          "thread missing",
          { code: -32602, message: "thread not found" },
          "thread/read",
        ),
      );
    await expect(readCodexNativeHistory(failed, "root")).rejects.toThrow(
      "thread missing",
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-thread responses and malformed supplied metadata", () => {
    expect(() => parseCodexNativeHistory(response(), "another")).toThrow(
      "different thread",
    );
    expect(() =>
      parseCodexNativeHistory(
        { ...response(), history: { version: 2, turns: [] } },
        "root",
      ),
    ).toThrow();
  });
});
