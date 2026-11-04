import { describe, expect, it, vi } from "vitest";
import type { OsExecutorConnection } from "./connection.js";
import { OsProcessOutcomeUnknownError, runGuestProcess } from "./process.js";

const connection = (request: unknown) => ({ request }) as OsExecutorConnection;
describe("native guest process receipts", () => {
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
