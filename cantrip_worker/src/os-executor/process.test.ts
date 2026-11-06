import { describe, expect, it, vi } from "vitest";
import type { OsExecutorConnection } from "./connection.js";
import { inspectLinuxSource } from "./checkouts.js";
import {
  OsProcessOutcomeUnknownError,
  runGuestProcess,
  observeGuestProcess,
} from "./process.js";

const connection = (request: unknown) => ({ request }) as OsExecutorConnection;
describe("native guest process receipts", () => {
  it("observes an admitted process without starting it or sending input", async () => {
    const request = vi.fn(async () => ({
      chunks: [],
      nextSeq: 1,
      exited: true,
      closed: true,
      exitCode: 0,
    }));
    expect(
      (await observeGuestProcess(connection(request), "known-process"))
        .exitCode,
    ).toBe(0);
    expect(request.mock.calls).toEqual([
      [
        "process/read",
        {
          processId: "known-process",
          afterSeq: null,
          maxBytes: 65536,
          waitMs: 200,
        },
      ],
    ]);
  });
  it("chunks finite input and preserves an uncertain write without repeating it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "process/write") throw new Error("delivery lost");
      return {};
    });
    await expect(
      runGuestProcess(connection(request), ["helper"], "/workspace", {
        stdin: "x".repeat(64000),
      }),
    ).rejects.toBeInstanceOf(OsProcessOutcomeUnknownError);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "process/start",
      "process/write",
    ]);
  });
  it("drains pages after exit, tolerates lifecycle sequence gaps and decodes each stream", async () => {
    const unicode = Buffer.from("日本語");
    const pages = [
      {
        chunks: [
          {
            seq: 1,
            stream: "stdout",
            chunk: unicode.subarray(0, 2).toString("base64"),
          },
        ],
        nextSeq: 2,
        exited: true,
        closed: false,
        exitCode: 0,
      },
      {
        chunks: [
          {
            seq: 3,
            stream: "stderr",
            chunk: Buffer.from("warning").toString("base64"),
          },
          {
            seq: 4,
            stream: "stdout",
            chunk: unicode.subarray(2).toString("base64"),
          },
        ],
        nextSeq: 5,
        exited: true,
        closed: true,
        exitCode: 0,
      },
      { chunks: [], nextSeq: 6, exited: true, closed: true, exitCode: 0 },
    ];
    const request = vi.fn(async (method: string) =>
      method === "process/start" ? {} : pages.shift(),
    );
    const result = await runGuestProcess(
      connection(request),
      ["example"],
      "/workspace/source",
    );
    expect(result.stdout).toBe("日本語");
    expect(result.stderr).toBe("warning");
    expect(result.output).toBe("warning日本語");
    expect(result.outputTruncated).toBe(false);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "process/start",
      "process/read",
      "process/read",
      "process/read",
    ]);
  });

  it("does not dispatch a mutation when durable process admission fails", async () => {
    const request = vi.fn();
    await expect(
      runGuestProcess(connection(request), ["example"], "/workspace/source", {
        prepared: async () => {
          throw new Error("durable admission failed");
        },
      }),
    ).rejects.toThrow("durable admission failed");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports actual native eviction while observing the existing process without terminating it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [
          {
            seq: 9,
            stream: "stdout",
            chunk: Buffer.from("tail").toString("base64"),
          },
        ],
        outputEvictedThroughSeq: 7,
        nextSeq: 10,
        exited: false,
        closed: false,
        exitCode: null,
      })
      .mockResolvedValueOnce({
        chunks: [],
        outputEvictedThroughSeq: 7,
        nextSeq: 11,
        exited: true,
        closed: true,
        exitCode: 0,
      });
    const result = await observeGuestProcess(connection(request), "existing");
    expect(result).toMatchObject({
      output: "tail",
      outputTruncated: true,
      outputCoverage: "reported",
      terminationRequested: null,
      exitCode: 0,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "process/read",
      "process/read",
    ]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ afterSeq: 9 });
  });

  it("does not confuse previously consumed eviction or lifecycle events with missing output", async () => {
    const pages = [
      {
        chunks: [{ seq: 3, stream: "stdout", chunk: "YQ==" }],
        nextSeq: 5,
        outputEvictedThroughSeq: 0,
        exited: false,
        closed: false,
        exitCode: null,
      },
      {
        chunks: [{ seq: 7, stream: "stdout", chunk: "Yg==" }],
        nextSeq: 9,
        outputEvictedThroughSeq: 3,
        exited: false,
        closed: false,
        exitCode: null,
      },
      {
        chunks: [],
        nextSeq: 10,
        outputEvictedThroughSeq: 3,
        exited: true,
        closed: true,
        exitCode: 0,
      },
    ];
    const request = vi.fn(async () => pages.shift());
    expect(
      await observeGuestProcess(connection(request), "existing"),
    ).toMatchObject({
      output: "ab",
      outputTruncated: false,
      outputCoverage: "reported",
    });
    expect(request.mock.calls).toHaveLength(3);
  });

  it("preserves compatibility with older executors without claiming retention coverage", async () => {
    const request = vi.fn(async () => ({
      chunks: [],
      nextSeq: 1,
      exited: true,
      closed: true,
      exitCode: 0,
    }));
    expect(
      await observeGuestProcess(connection(request), "existing"),
    ).toMatchObject({
      exitCode: 0,
      outputCoverage: "unavailable",
      outputTruncated: false,
    });
  });

  it("keeps a source inspection outcome unknown when its successful command lost output", async () => {
    let read = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "fs/canonicalize") return { path: "file:///workspace" };
      if (method === "fs/getMetadata") return { isDirectory: true };
      if (method === "process/start") return {};
      if (method === "process/read")
        return {
          chunks:
            read++ === 0
              ? [
                  {
                    seq: 5,
                    stream: "stdout",
                    chunk: Buffer.from("revision-tail").toString("base64"),
                  },
                ]
              : [],
          nextSeq: 6,
          outputEvictedThroughSeq: 3,
          exited: true,
          closed: true,
          exitCode: 0,
        };
      throw new Error(`Unexpected request ${method}`);
    });
    await expect(
      inspectLinuxSource(connection(request), {
        sourceId: "00000000-0000-4000-8000-000000000001",
        guestPath: "/workspace",
        sourceKind: "git",
      }),
    ).rejects.toBeInstanceOf(OsProcessOutcomeUnknownError);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "fs/canonicalize",
      "fs/getMetadata",
      "process/start",
      "process/read",
      "process/read",
    ]);
  });

  it("does not cancel a process when read-only observation exceeds its output bound", async () => {
    const request = vi.fn(async () => ({
      chunks: [
        {
          seq: 1,
          stream: "stdout",
          chunk: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
        },
      ],
      nextSeq: 2,
      exited: false,
      closed: false,
      exitCode: null,
    }));
    await expect(
      observeGuestProcess(connection(request), "existing"),
    ).rejects.toBeInstanceOf(OsProcessOutcomeUnknownError);
    expect(request.mock.calls).toHaveLength(1);
  });

  it("retains the process identity after uncertain start delivery without retrying", async () => {
    const request = vi.fn().mockRejectedValue(new Error("transport lost"));
    const processId = "fixed-process";
    const error = await runGuestProcess(
      connection(request),
      ["mutate"],
      "/workspace/source",
      { processId },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OsProcessOutcomeUnknownError);
    expect(error).toMatchObject({ processId, delivery: "unknown" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
