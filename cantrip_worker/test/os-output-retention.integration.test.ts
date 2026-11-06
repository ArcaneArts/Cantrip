import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { observeGuestProcess } from "../src/os-executor/process.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);

describe.skipIf(!enabled)("real native output retention", () => {
  it("reports evicted history after carrier loss without replaying or terminating the admitted process", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const workspace = `history-${randomUUID().slice(0, 12)}`;
    await workspaceControl(transport, ["create", workspace]);
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      workspace,
    ]);
    const first = new OsExecutorConnection(transport, binding);
    const second = new OsExecutorConnection(transport, binding);
    const processId = randomUUID();
    let observing: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const initialized = await first.request<{ sessionId: string }>(
        "initialize",
        { clientName: "retention-before-loss", resumeSessionId: null },
      );
      first.notify("initialized");
      await first.request("process/start", {
        processId,
        argv: [
          "python3",
          "-u",
          "-c",
          [
            "import pathlib,time,os",
            "p=pathlib.Path('once');p.write_text((p.read_text() if p.exists() else '')+'once\\n')",
            "while not pathlib.Path('flood').exists():time.sleep(.02)",
            "print('EARLY_OUTPUT',flush=True)",
            "print('x'*(2*1024*1024),flush=True)",
            "pathlib.Path('ready').write_text(str(os.getpid()))",
            "while not pathlib.Path('release').exists():time.sleep(.02)",
            "print('FINAL_OUTPUT',flush=True)",
          ].join("\n"),
        ],
        cwd: guestFileUri(binding.home),
        env: {},
        tty: false,
        arg0: null,
        sandbox: null,
      });
      await first.close();
      expect(
        await second.request("initialize", {
          clientName: "retention-after-loss",
          resumeSessionId: initialized.sessionId,
        }),
      ).toMatchObject(initialized);
      second.notify("initialized");
      const put = (name: string) =>
        second.request("fs/writeFile", {
          path: guestFileUri(`${binding.home}/${name}`),
          dataBase64: "Z28=",
          sandbox: null,
        });
      const get = async (name: string) => {
        const file = await second.request<{ dataBase64: string }>(
          "fs/readFile",
          { path: guestFileUri(`${binding.home}/${name}`), sandbox: null },
        );
        return Buffer.from(file.dataBase64, "base64").toString();
      };
      await put("flood");
      await expect
        .poll(
          async () => {
            try {
              return await get("ready");
            } catch {
              return "";
            }
          },
          { timeout: 30000 },
        )
        .toMatch(/^\d+$/);
      const read = await second.request<{
        outputEvictedThroughSeq: number;
        exited: boolean;
      }>("process/read", {
        processId,
        afterSeq: null,
        maxBytes: 65536,
        waitMs: 0,
      });
      expect(read.outputEvictedThroughSeq).toBeGreaterThan(0);
      expect(read.exited).toBe(false);
      await put("release");
      const request = vi.spyOn(second, "request");
      observing = request;
      const result = await observeGuestProcess(second, processId);
      expect(result).toMatchObject({
        processId,
        exitCode: 0,
        outputTruncated: true,
        outputCoverage: "reported",
        terminationRequested: null,
      });
      expect(result.stdout).toContain("FINAL_OUTPUT");
      expect(result.stdout).not.toContain("EARLY_OUTPUT");
      expect(
        request.mock.calls.every(([method]) => method === "process/read"),
      ).toBe(true);
      request.mockRestore();
      observing = undefined;
      expect(await get("once")).toBe("once\n");
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase5-output-retention/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(`retention-${transport.kind}-${workspace}.json`, artifacts),
        JSON.stringify(
          {
            workspace,
            sessionId: initialized.sessionId,
            processId,
            evictionBoundary: read.outputEvictedThroughSeq,
            retainedBytes: Buffer.byteLength(result.stdout),
            exitCode: result.exitCode,
            outputTruncated: result.outputTruncated,
            outputCoverage: result.outputCoverage,
            executedOnce: true,
          },
          null,
          2,
        ),
      );
    } finally {
      observing?.mockRestore();
      await second.request("process/terminate", { processId }).catch(() => {});
      await first.close();
      await second.close();
      await executorControl(transport, ["close", workspace]);
    }
  }, 60000);
});
