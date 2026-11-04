import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { runGuestProcess } from "../src/os-executor/process.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);

describe.skipIf(!enabled)("real Linux native process cancellation", () => {
  it("kills sudo descendants across setsid without stopping an independent job", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? (JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        ) as OsExecutorTransport)
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const workspace = `cancel-${randomUUID().slice(0, 12)}`;
    await workspaceControl(transport, ["create", workspace]);
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      workspace,
    ]);
    const connection = new OsExecutorConnection(transport, binding);
    await connection.request("initialize", {
      clientName: "cantrip-cancel-acceptance",
      resumeSessionId: null,
    });
    connection.notify("initialized");
    const unrelatedId = randomUUID();
    const marker = `${binding.home}/Documents/root-descendants.json`;
    const controller = new AbortController();
    let pids: number[] = [];
    let completion: ReturnType<typeof runGuestProcess> | undefined;
    try {
      const identity = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          "import os;print(os.getuid());print(next(line.strip() for line in open('/proc/self/status') if line.startswith('CapEff:')))",
        ],
        binding.home,
      );
      expect(identity.exitCode).toBe(0);
      expect(identity.stdout.trim().split("\n")).toEqual([
        String(binding.uid),
        "CapEff:\t0000000000000000",
      ]);
      await connection.request("process/start", {
        processId: unrelatedId,
        argv: ["sleep", "60"],
        cwd: guestFileUri(binding.home),
        env: {},
        tty: false,
        arg0: null,
        sandbox: null,
      });
      completion = runGuestProcess(
        connection,
        [
          "sudo",
          "-n",
          "python3",
          "-u",
          "-c",
          [
            "import os,sys,subprocess,json",
            "p=subprocess.Popen(['python3','-c',\"import subprocess,sys;p=subprocess.Popen(['sleep','60']);print(p.pid,flush=True);p.wait()\"],start_new_session=True,stdout=subprocess.PIPE,text=True)",
            "child=int(p.stdout.readline())",
            "open(sys.argv[1],'w').write(json.dumps([os.getpid(),p.pid,child]))",
            "p.wait()",
          ].join("\n"),
          marker,
        ],
        binding.home,
        { signal: controller.signal },
      );
      // The actual marker proves the entire root-owned tree has started.
      const deadline = Date.now() + 10_000;
      while (!pids.length && Date.now() < deadline) {
        try {
          const file = await connection.request<{ dataBase64: string }>(
            "fs/readFile",
            { path: guestFileUri(marker), sandbox: null },
          );
          pids = JSON.parse(
            Buffer.from(file.dataBase64, "base64").toString(),
          ) as number[];
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(pids).toHaveLength(3);
      controller.abort();
      const outcome = await completion;
      expect(outcome.terminationRequested).toBe("cancelled");
      expect(outcome.exitCode).not.toBe(0);
      const observed = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          [
            "import os,sys,time,json",
            "deadline=time.monotonic()+5",
            "while True:",
            " states={p:open('/proc/'+p+'/stat').read().rsplit(')',1)[1].split()[0] if os.path.exists('/proc/'+p) else None for p in sys.argv[1:]}",
            " if all(s in (None,'Z') for s in states.values()) or time.monotonic()>=deadline: break",
            " time.sleep(.02)",
            "print(json.dumps(states))",
          ].join("\n"),
          ...pids.map(String),
        ],
        binding.home,
      );
      expect(observed.exitCode).toBe(0);
      const states = JSON.parse(observed.stdout) as Record<
        string,
        string | null
      >;
      expect(
        Object.values(states).every((state) => state === null || state === "Z"),
      ).toBe(true);
      expect(
        await connection.request("process/read", {
          processId: unrelatedId,
          afterSeq: null,
          maxBytes: 1024,
          waitMs: 0,
        }),
      ).toMatchObject({ exited: false });
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase3-sources/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(
          `root-cancellation-${transport.kind}-${workspace}.json`,
          artifacts,
        ),
        JSON.stringify(
          {
            binding,
            identity,
            outcome,
            pids,
            states,
            independentProcessRunning: true,
          },
          null,
          2,
        ),
      );
    } finally {
      controller.abort();
      await completion?.catch(() => {});
      await connection
        .request("process/terminate", { processId: unrelatedId })
        .catch(() => {});
      if (pids.length)
        await runGuestProcess(
          connection,
          ["sudo", "-n", "kill", "-KILL", ...pids.map(String)],
          binding.home,
        ).catch(() => {});
      await connection.close();
      await executorControl(transport, ["close", workspace]);
    }
  }, 90_000);
});
