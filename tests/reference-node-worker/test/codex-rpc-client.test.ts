import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CodexRpcClient,
  codexRpcExitMessage,
} from "../src/codex/rpc-client.js";

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

describe("Codex RPC client", () => {
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

  it("retains the final Windows startup diagnostic after stderr closes", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'process.stderr.write("\\u001b[31merror: failed to open state database\\u001b[0m\\r\\nCaused by: The process cannot access the file\\r\\n"); setTimeout(() => process.exit(1), 25);',
      ],
      { stdio: "pipe", windowsHide: true },
    );
    const client = new CodexRpcClient(child, 1_000);
    const pending = client.request("initialize", {});

    await expect(pending).rejects.toThrow(
      "Codex app-server exited (code 1): Caused by: The process cannot access the file",
    );
  });

  it("bounds and redacts subprocess diagnostics before surfacing them", () => {
    const message = codexRpcExitMessage(
      1,
      null,
      `${"discarded".repeat(4_000)}\r\n` +
        'fatal: OPENAI_API_KEY="sk-private" Bearer bearer-private https://user:password@example.com\r\n',
    );

    expect(message.length).toBeLessThan(2_100);
    expect(message).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(message).toContain("Bearer [REDACTED]");
    expect(message).toContain("https://[REDACTED]@example.com");
    expect(message).not.toContain("sk-private");
    expect(message).not.toContain("bearer-private");
    expect(message).not.toContain("user:password");
    expect(message).not.toContain("discarded");
  });
});
