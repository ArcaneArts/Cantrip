import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";

// Opt-in: a real disposable OS with the package enabled and exec-a/exec-b
// workspace accounts created. A transport file may select a test VM via SSH.
const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
type ReadResult = {
  chunks: { chunk: string; seq: number }[];
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
};
const uri = (path: string) => new URL(`file://${path}`).href;

async function initialize(
  connection: OsExecutorConnection,
  resumeSessionId?: string,
) {
  const result = await connection.request<{
    sessionId: string;
    environmentInfo: { platformOs: string };
  }>("initialize", {
    clientName: "cantrip-os-acceptance",
    resumeSessionId: resumeSessionId ?? null,
  });
  connection.notify("initialized");
  expect(result.environmentInfo.platformOs).toBe("linux");
  return result.sessionId;
}

async function start(connection: OsExecutorConnection, command: string) {
  const processId = randomUUID();
  await connection.request("process/start", {
    processId,
    argv: ["/bin/bash", "-c", command],
    cwd: uri(connection.binding.home),
    env: {},
    tty: false,
    arg0: null,
    sandbox: null,
  });
  return processId;
}

async function output(connection: OsExecutorConnection, processId: string) {
  let afterSeq: number | null = null,
    text = "";
  for (let count = 0; count < 100; count++) {
    const result: ReadResult = await connection.request<ReadResult>(
      "process/read",
      {
        processId,
        afterSeq,
        maxBytes: 65536,
        waitMs: 200,
      },
    );
    for (const chunk of result.chunks)
      text += Buffer.from(chunk.chunk, "base64").toString();
    // Native nextSeq is the next event to be assigned; afterSeq is exclusive.
    afterSeq = Math.max(0, result.nextSeq - 1);
    if (result.exited) return { text, exitCode: result.exitCode };
  }
  throw new Error("Actual Linux process did not exit");
}

describe.skipIf(!enabled)("real CantripOS native executor", () => {
  it("delegates native files/processes, resumes without replay and rejects stale targets", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? (JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        ) as OsExecutorTransport)
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    await executorControl(transport, [
      "attach",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    const a = await executorControl<OsExecutorBinding>(transport, [
      "open",
      "exec-a",
    ]);
    const b = await executorControl<OsExecutorBinding>(transport, [
      "open",
      "exec-b",
    ]);
    expect(a.instance_id).toBe(b.instance_id);
    expect(a.uid).not.toBe(b.uid);
    expect(a).not.toHaveProperty("token");
    let first = new OsExecutorConnection(transport, a);
    let second: OsExecutorConnection | undefined;
    try {
      const session = await initialize(first);
      second = new OsExecutorConnection(transport, b);
      await initialize(second);
      const unauthenticated = await output(
        first,
        await start(
          first,
          `python3 - <<'PY'
import websocket
try:
 connection=websocket.create_connection(${JSON.stringify(a.url)},suppress_origin=True)
except websocket.WebSocketBadStatusException as error:
 assert error.status_code==401,error.status_code
 print('AUTH_REQUIRED')
else:
 connection.close()
 raise RuntimeError('Unauthenticated executor connection accepted')
PY`,
        ),
      );
      expect(unauthenticated.exitCode).toBe(0);
      expect(unauthenticated.text).toContain("AUTH_REQUIRED");
      for (const [connection, value] of [
        [first, "EXECUTOR_A"],
        [second, "EXECUTOR_B"],
      ] as const) {
        const path = uri(
          connection.binding.home + "/Documents/executor-test.txt",
        );
        await connection.request("fs/writeFile", {
          path,
          dataBase64: Buffer.from(value).toString("base64"),
          sandbox: null,
        });
        const data = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          { path, sandbox: null },
        );
        expect(Buffer.from(data.dataBase64, "base64").toString()).toBe(value);
        const processId = await start(
          connection,
          'id -u; pwd; sudo -n id -u; test -z "${DISPLAY:-}"',
        );
        const result = await output(connection, processId);
        expect(result.exitCode).toBe(0);
        expect(result.text.trim().split("\n")).toEqual([
          String(connection.binding.uid),
          connection.binding.home,
          "0",
        ]);
      }

      const countPath = uri(a.home + "/Documents/execution-count");
      await first.request("fs/writeFile", {
        path: countPath,
        dataBase64: "",
        sandbox: null,
      });
      const retained = await start(
        first,
        "echo once >> Documents/execution-count; sleep 2; echo finished",
      );
      await first.close();
      first = new OsExecutorConnection(transport, a);
      expect(await initialize(first, session)).toBe(session);
      expect((await output(first, retained)).text).toContain("finished");
      const count = await first.request<{ dataBase64: string }>("fs/readFile", {
        path: countPath,
        sandbox: null,
      });
      expect(Buffer.from(count.dataBase64, "base64").toString()).toBe("once\n");
      await first.request("fs/writeFile", {
        path: uri(a.home + "/Documents/executor-child.pid"),
        dataBase64: "",
        sandbox: null,
      });
      const long = await start(
        first,
        "sleep 300 & echo $! > Documents/executor-child.pid; wait",
      );
      const child = await output(
        first,
        await start(
          first,
          "for i in $(seq 1 100); do test -s Documents/executor-child.pid && { cat Documents/executor-child.pid; exit; }; sleep .1; done; exit 1",
        ),
      );
      expect(child.exitCode).toBe(0);
      const childPid = child.text.trim();
      expect(childPid).toMatch(/^[1-9][0-9]*$/);
      await first.request("process/terminate", { processId: long });
      await output(first, long);
      const cleanup = await output(
        first,
        await start(
          first,
          `for i in $(seq 1 100); do kill -0 ${childPid} 2>/dev/null || exit 0; sleep .1; done; exit 1`,
        ),
      );
      expect(cleanup.exitCode).toBe(0);
      expect(
        (await output(second, await start(second, "echo unaffected"))).text,
      ).toContain("unaffected");

      expect(
        (
          await output(
            first,
            await start(
              first,
              "sudo -n apt-get update && sudo -n apt-get install -y --no-install-recommends hello",
            ),
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await output(second, await start(second, "hello"))).text,
      ).toContain("Hello, world!");

      expect(
        (
          await output(
            second,
            await start(second, "sudo -n cantrip-workspaces open exec-b"),
          )
        ).exitCode,
      ).toBe(0);
      const independent = await start(
        second,
        "sleep 2; echo survived-desktop-stop",
      );
      expect(
        (
          await output(
            second,
            await start(second, "sudo -n cantrip-workspaces stop exec-b"),
          )
        ).exitCode,
      ).toBe(0);
      expect((await output(second, independent)).text).toContain(
        "survived-desktop-stop",
      );

      // A session-leader child escapes the shell's process group. Closing the
      // workspace executor must still reap its owned descendant tree.
      await first.request("fs/writeFile", {
        path: uri(a.home + "/Documents/executor-detached.pid"),
        dataBase64: "",
        sandbox: null,
      });
      await start(
        first,
        "setsid sleep 300 >/dev/null 2>&1 </dev/null & echo $! > Documents/executor-detached.pid; wait",
      );
      const detached = await output(
        first,
        await start(
          first,
          "for i in $(seq 1 100); do test -s Documents/executor-detached.pid && { cat Documents/executor-detached.pid; exit; }; sleep .1; done; exit 1",
        ),
      );
      expect(detached.exitCode).toBe(0);
      const detachedPid = detached.text.trim();
      expect(detachedPid).toMatch(/^[1-9][0-9]*$/);
      await executorControl(transport, ["close", "exec-a"]);
      expect(
        (
          await output(
            second,
            await start(
              second,
              `for i in $(seq 1 100); do sudo -n kill -0 ${detachedPid} 2>/dev/null || exit 0; sleep .1; done; exit 1`,
            ),
          )
        ).exitCode,
      ).toBe(0);
      const replacement = await executorControl<OsExecutorBinding>(transport, [
        "open",
        "exec-a",
      ]);
      expect(replacement.executor_generation).not.toBe(a.executor_generation);
      const stale = new OsExecutorConnection(transport, a);
      try {
        await expect(initialize(stale)).rejects.toThrow();
      } finally {
        await stale.close();
      }
      const wrongOwner = new OsExecutorConnection(transport, {
        ...b,
        owner_id: "wrong-owner",
      });
      try {
        await expect(initialize(wrongOwner)).rejects.toThrow();
      } finally {
        await wrongOwner.close();
      }
      expect(
        (await output(second, await start(second, "echo still-running"))).text,
      ).toContain("still-running");
    } finally {
      await first.close();
      await second?.close();
      await executorControl(transport, ["close", "exec-a"]);
      await executorControl(transport, ["close", "exec-b"]);
    }
  }, 120_000);
});
