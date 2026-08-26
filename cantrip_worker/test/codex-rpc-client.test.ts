import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { CodexRpcClient } from "../src/codex/rpc-client.js";

function rpcProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter &
    Partial<ChildProcessWithoutNullStreams>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdin?.end();
    child.stdout?.end();
    child.stderr?.end();
    return true;
  };
  return child as ChildProcessWithoutNullStreams;
}

describe("Codex RPC client notifications", () => {
  it("buffers an import completion that arrives before its waiter", async () => {
    const child = rpcProcess();
    const client = new CodexRpcClient(child, 1_000);
    child.stdout.write(
      `${JSON.stringify({
        method: "externalAgentConfig/import/completed",
        params: { importId: "import-one" },
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      client.waitForNotification(
        "externalAgentConfig/import/completed",
        (params) => (params as { importId?: string }).importId === "import-one",
      ),
    ).resolves.toMatchObject({
      method: "externalAgentConfig/import/completed",
      params: { importId: "import-one" },
    });
    client.close();
  });
});
