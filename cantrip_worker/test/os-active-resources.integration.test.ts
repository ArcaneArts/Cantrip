import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { describe, it, expect } from "vitest";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { docker, sample } from "./fixtures/os-stream-workload.js";
const exec = promisify(execFile);
const image = process.env.CANTRIP_OS_RESOURCE_TEST_IMAGE;
const output = process.env.CANTRIP_OS_RESOURCE_OUTPUT;

describe.skipIf(!image)("actual 4 GiB active workspace resources", () => {
  it("runs two active Chromium desktops and two native executor workloads", async () => {
    const container = `cantrip-os-active-resource-${process.pid}`;
    const transport = { kind: "docker" as const, container };
    const clients: OsExecutorConnection[] = [];
    const jobs: {
      connection: OsExecutorConnection;
      processId: string;
      port: number;
      initialFrames: number;
    }[] = [];
    const evidence = {
      image,
      imageId: "",
      measuredAt: new Date().toISOString(),
      limitBytes: 4294967296,
      scope:
        "personal desktop plus two 1440x900 workspace desktops, each running an animated Chromium page and a real native executor loop hashing/writing files every 50ms; no viewers, Worker/model outside OS",
      stages: [] as unknown[],
    };
    let started = false;
    const measure = async (stage: string) => {
      await delay(2000);
      const first = await sample(container),
        at = performance.now(),
        samples = [first];
      for (let index = 0; index < 5; index++) {
        await delay(2000);
        samples.push(await sample(container));
      }
      const last = samples.at(-1)!;
      expect(last.limit).toBe(String(evidence.limitBytes));
      expect(last.oom).toMatch(/oom_kill 0/u);
      const row = {
        stage,
        elapsedMs: performance.now() - at,
        guestCpuPercentOfOneCore:
          (last.cpuUsec - first.cpuUsec) / (performance.now() - at) / 10,
        samples,
      };
      evidence.stages.push(row);
    };
    const start = async (connection: OsExecutorConnection, command: string) => {
      const processId = randomUUID();
      await connection.request("process/start", {
        processId,
        argv: ["/bin/bash", "-c", command],
        cwd: guestFileUri(connection.binding.home),
        env: {},
        tty: false,
        arg0: null,
        sandbox: null,
      });
      return processId;
    };
    try {
      await exec("docker", [
        "run",
        "--rm",
        "-d",
        "--name",
        container,
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "--shm-size",
        "1g",
        image!,
      ]);
      started = true;
      const inspected = JSON.parse(
        (await exec("docker", ["inspect", container])).stdout,
      )[0];
      evidence.imageId = inspected.Image;
      expect(inspected.HostConfig.Memory).toBe(evidence.limitBytes);
      for (let tries = 0; ; tries++) {
        try {
          const status = JSON.parse(
            await docker(container, "cantrip-workspaces", "status"),
          );
          if (status.service === "running") break;
        } catch (error) {
          if (tries >= 100) throw error;
        }
        if (tries >= 100)
          throw new Error("The actual workspace manager did not start.");
        await delay(100);
      }
      await measure("idle OS");
      await executorControl(transport, [
        "attach",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]);
      const html = await readFile(
        path.resolve("../cantrip_os/tests/active-browser.html"),
      );
      for (const [index, workspace] of ["active-a", "active-b"].entries()) {
        await docker(container, "cantrip-workspaces", "create", workspace);
        await docker(container, "cantrip-workspaces", "open", workspace);
        const binding = await executorControl<OsExecutorBinding>(transport, [
          "open",
          workspace,
        ]);
        const connection = new OsExecutorConnection(transport, binding);
        clients.push(connection);
        await connection.request("initialize", {
          clientName: "CantripOS active resource acceptance",
          resumeSessionId: null,
        });
        connection.notify("initialized");
        const file = binding.home + "/Documents/active-browser.html";
        await connection.request("fs/writeFile", {
          path: guestFileUri(file),
          dataBase64: html.toString("base64"),
          sandbox: null,
        });
        const port = 9222 + index;
        const browserId = await start(
          connection,
          `cantrip-desktop /usr/local/bin/cantrip-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --app=file://${file}`,
        );
        const processId = await start(
          connection,
          `python3 -u - <<'PY'
import hashlib,pathlib,time
p=pathlib.Path('Documents/executor-active-proof');data=b'CantripOS real executor workload'*2048
for tick in range(12000):
 p.write_text(str(tick)+' '+hashlib.sha256(data).hexdigest())
 if tick%20==0:print('active',tick,flush=True)
 time.sleep(.05)
PY`,
        );

        // Ask the actual browser's local DevTools listing for its rendered title.
        let title = "";
        for (let tries = 0; tries < 100; tries++) {
          try {
            title =
              JSON.parse(
                await docker(
                  container,
                  "python3",
                  "-c",
                  `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/json/list').read().decode())`,
                ),
              ).find((tab: { type: string }) => tab.type === "page")?.title ??
              "";
            if (/active frames [1-9]/u.test(title)) break;
          } catch {
            /* Actual browser can still be launching. */
          }
          await delay(100);
        }
        if (!/active frames [1-9]/u.test(title)) {
          const result = await connection.request<{
            chunks: { chunk: string }[];
          }>("process/read", {
            processId: browserId,
            afterSeq: null,
            maxBytes: 65536,
            waitMs: 200,
          });
          throw new Error(
            "Actual Chromium failed to render: " +
              result.chunks
                .map((chunk) => Buffer.from(chunk.chunk, "base64").toString())
                .join(""),
          );
        }
        jobs.push({
          connection,
          processId,
          port,
          initialFrames: Number(title.match(/active frames (\d+)/u)![1]),
        });
        await measure(
          index
            ? "two active desktops and executors"
            : "one active desktop and executor",
        );
      }
      for (const { connection, processId, port, initialFrames } of jobs) {
        const row = await connection.request<{
          chunks: { chunk: string }[];
          exited: boolean;
        }>("process/read", {
          processId,
          afterSeq: null,
          maxBytes: 65536,
          waitMs: 200,
        });
        expect(row.exited).toBe(false);
        expect(
          row.chunks
            .map((chunk) => Buffer.from(chunk.chunk, "base64").toString())
            .join(""),
        ).toContain("active");
        const proof = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          {
            path: guestFileUri(
              connection.binding.home + "/Documents/executor-active-proof",
            ),
            sandbox: null,
          },
        );
        expect(
          Number(
            Buffer.from(proof.dataBase64, "base64").toString().split(" ")[0],
          ),
        ).toBeGreaterThan(100);
        const tabs = JSON.parse(
          await docker(
            container,
            "python3",
            "-c",
            `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/json/list').read().decode())`,
          ),
        );
        expect(
          tabs.some(
            (tab: { title: string }) =>
              Number(tab.title.match(/active frames (\d+)/u)?.[1] ?? 0) >
              initialFrames,
          ),
        ).toBe(true);
      }
      if (output) {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      for (const { connection, processId } of jobs)
        await connection
          .request("process/terminate", { processId })
          .catch(() => {});
      await Promise.allSettled(clients.map((connection) => connection.close()));
      if (started) await exec("docker", ["stop", "--time", "30", container]);
    }
  }, 180_000);
});
