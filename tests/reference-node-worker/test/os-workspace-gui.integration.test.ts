import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

describe.skipIf(!enabled)("packaged workspace GUI commands", () => {
  it("uses each assigned display and keeps independent shells alive after desktop stop", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    await executorControl(transport, [
      "attach",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    const targets: Array<{
      name: string;
      home: string;
      display: number;
      uid: number;
      connection: OsExecutorConnection;
      processes: string[];
    }> = [];
    const proof: unknown[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const name = `gui-${randomUUID().slice(0, 12)}`;
        const workspace = await workspaceControl<{
          home: string;
          display: number;
          uid: number;
        }>(transport, ["create", name]);
        const binding = await executorControl<OsExecutorBinding>(transport, [
          "open",
          name,
        ]);
        const connection = new OsExecutorConnection(transport, binding);
        const target = {
          name,
          ...workspace,
          connection,
          processes: [] as string[],
        };
        targets.push(target);
        await connection.request("initialize", {
          clientName: "workspace-gui-acceptance",
          resumeSessionId: null,
        });
        connection.notify("initialized");
        const ordinary = await runGuestProcess(
          connection,
          [
            "python3",
            "-c",
            'import os;assert "DISPLAY" not in os.environ;print(os.getuid())',
          ],
          workspace.home,
        );
        expect(ordinary.exitCode).toBe(0);
        expect(ordinary.stdout.trim()).toBe(String(workspace.uid));
        await workspaceControl(transport, ["open", name]);
        const cwd = `${workspace.home}/GUI source 日本語`;
        expect(
          (await runGuestProcess(connection, ["mkdir", cwd], workspace.home))
            .exitCode,
        ).toBe(0);
        const shellId = randomUUID();
        target.processes.push(shellId);
        await connection.request("process/start", {
          processId: shellId,
          argv: ["sleep", "300"],
          cwd: guestFileUri(cwd),
          env: {},
          tty: false,
          pipeStdin: false,
          arg0: null,
          sandbox: null,
        });
        const guiId = randomUUID();
        target.processes.push(guiId);
        await connection.request("process/start", {
          processId: guiId,
          argv: [
            "cantrip-desktop",
            "xterm",
            "-title",
            name,
            "-e",
            "python3",
            "-c",
            'import os,json,time,pathlib;pathlib.Path("gui-proof.json").write_text(json.dumps({"uid":os.getuid(),"cwd":os.getcwd(),"env":{k:os.getenv(k) for k in ["DISPLAY","XAUTHORITY","WAYLAND_DISPLAY","DBUS_SESSION_BUS_ADDRESS","XDG_RUNTIME_DIR"]}}));time.sleep(300)',
          ],
          cwd: guestFileUri(cwd),
          env: {
            DISPLAY: ":0",
            XAUTHORITY: "/wrong/personal-cookie",
            WAYLAND_DISPLAY: "personal-console",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/wrong/personal-bus",
          },
          tty: false,
          pipeStdin: false,
          arg0: null,
          sandbox: null,
        });
        let windows = "";
        const deadline = Date.now() + 120_000;
        do {
          const result = await runGuestProcess(
            connection,
            ["cantrip-desktop", "xwininfo", "-root", "-tree"],
            cwd,
          );
          expect(result.exitCode).toBe(0);
          windows = result.stdout;
          if (windows.includes(name)) break;
        } while (Date.now() < deadline);
        if (!windows.includes(name)) {
          const outcome = await connection.request<{
            exited: boolean;
            exitCode: number | null;
            chunks: Array<{ chunk: string }>;
          }>("process/read", {
            processId: guiId,
            afterSeq: null,
            maxBytes: 8192,
            waitMs: 0,
          });
          console.error("GUI launch outcome", name, {
            ...outcome,
            chunks: outcome.chunks.map(({ chunk }) =>
              Buffer.from(chunk, "base64").toString(),
            ),
          });
        }
        expect(windows).toContain(name);
        let actual!: {
          uid: number;
          cwd: string;
          env: Record<string, string | null>;
        };
        await expect
          .poll(
            async () => {
              const contents = await connection.request<{ dataBase64: string }>(
                "fs/readFile",
                {
                  path: guestFileUri(`${cwd}/gui-proof.json`),
                  sandbox: null,
                },
              );
              actual = JSON.parse(
                Buffer.from(contents.dataBase64, "base64").toString(),
              );
              return actual;
            },
            { timeout: 20_000 },
          )
          .toMatchObject({ uid: workspace.uid, cwd });
        expect(actual).toMatchObject({
          uid: workspace.uid,
          cwd,
          env: {
            DISPLAY: `:${workspace.display}`,
            XAUTHORITY: null,
            WAYLAND_DISPLAY: null,
            XDG_RUNTIME_DIR: `/run/user/${workspace.uid}`,
          },
        });
        expect(actual.env.DBUS_SESSION_BUS_ADDRESS).not.toBe(
          "unix:path=/wrong/personal-bus",
        );
        expect(actual.env.DBUS_SESSION_BUS_ADDRESS).toMatch(/^unix:/);
        proof.push({ workspace: name, display: workspace.display, ...actual });
      }
      expect(targets[0].display).not.toBe(targets[1].display);
      for (const target of targets) {
        const windows = await runGuestProcess(
          target.connection,
          ["cantrip-desktop", "xwininfo", "-root", "-tree"],
          target.home,
        );
        expect(windows.stdout).toContain(target.name);
        expect(windows.stdout).not.toContain(
          targets.find((other) => other !== target)!.name,
        );
      }
      await workspaceControl(transport, ["stop", targets[0].name]);
      const shell = await targets[0].connection.request<{ exited: boolean }>(
        "process/read",
        {
          processId: targets[0].processes[0],
          afterSeq: null,
          maxBytes: 1024,
          waitMs: 0,
        },
      );
      expect(shell.exited).toBe(false);
      const unavailable = await runGuestProcess(
        targets[0].connection,
        ["cantrip-desktop", "xterm", "-title", "must-not-reach-console"],
        targets[0].home,
      );
      expect(unavailable.exitCode).not.toBe(0);
      expect(unavailable.output).toContain(`:${targets[0].display}`);
      const remaining = await runGuestProcess(
        targets[1].connection,
        ["cantrip-desktop", "xwininfo", "-root", "-tree"],
        targets[1].home,
      );
      expect(remaining.stdout).toContain(targets[1].name);
      if (process.env.CANTRIP_OS_GUI_PROOF)
        await writeFile(
          process.env.CANTRIP_OS_GUI_PROOF,
          JSON.stringify(
            {
              targets: proof,
              independentShellSurvived: true,
              stoppedDisplayFailedWithoutFallback: true,
            },
            null,
            2,
          ),
        );
    } finally {
      for (const target of targets) {
        for (const processId of target.processes)
          await target.connection
            .request("process/terminate", { processId })
            .catch(() => undefined);
        await target.connection.close();
        await executorControl(transport, ["close", target.name]);
        await workspaceControl(transport, ["stop", target.name]);
      }
    }
  }, 360_000);
});
