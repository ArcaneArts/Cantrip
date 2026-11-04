import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { CantripOsController } from "../src/os-executor/controller.js";
import * as pty from "node-pty";
import { runGuestProcess } from "../src/os-executor/process.js";
import {
  OsTerminalLauncher,
  osTerminalBridgeCommand,
  osTerminalOutcome,
} from "../src/os-executor/terminal-launcher.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)("actual Linux terminal carrier", () => {
  it("runs the shell and nano in its guest source and forwards real PTY dimensions", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-terminal-"),
    );
    const ownerId = "00000000-0000-4000-8000-000000000001",
      workerId = "00000000-0000-4000-8000-000000000002";
    const controller = new CantripOsController(directory, workerId);
    const observed = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as { guestInstanceId: string; runtimeGeneration: string };
    const core = {
      ownerId,
      workerId,
      serverId: "terminal-acceptance",
      guestInstanceId: observed.guestInstanceId,
      instanceId: randomUUID(),
      runtimeGeneration: observed.runtimeGeneration,
      attachmentGeneration: randomUUID(),
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: core,
      transport,
    });
    const guestWorkspaceId = `ter-${randomUUID().slice(0, 12)}`;
    const profile = (await controller.handle({
      type: "cantrip-os.workspaces.create",
      scope: core,
      transport,
      guestWorkspaceId,
      operationId: randomUUID(),
    })) as {
      state: string;
      receipt: {
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    expect(profile.state).toBe("ready");
    const projectSourceId = randomUUID();
    const scope = {
      ...core,
      ...profile.receipt.workspace,
      guestWorkspaceId,
      projectId: randomUUID(),
      projectSourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      workspaceId: randomUUID(),
      sourceKind: "folder" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
      guestPath: `${profile.receipt.workspace.homeGuestPath}/checkouts/${projectSourceId}`,
    };
    expect(
      (
        (await controller.handle({
          type: "cantrip-os.source.provision",
          scope,
          transport,
          operationId: randomUUID(),
          intent: { mode: "linux-owned", source: { kind: "folder" } },
        })) as { state: string }
      ).state,
    ).toBe("ready");
    const { serverId: _serverId, ...executionScope } = scope;
    const execution = {
      kind: "cantrip-os" as const,
      scope: executionScope,
      transport,
    };
    const launcher = new OsTerminalLauncher(directory, controller, {
      ownerId: () => ownerId,
      serverIdentity: () => core.serverId,
    });
    const terminalId = randomUUID();
    const prepared = await launcher.prepare(
      terminalId,
      execution,
      scope.guestPath,
      90,
      28,
      core.serverId,
    );
    expect(prepared.cwd).not.toBe(scope.guestPath);
    const manager = new TerminalManager();
    let output = "";
    const opened = manager.open(
      terminalId,
      randomUUID(),
      prepared.cwd,
      90,
      28,
      prepared.launch,
      (event) => {
        if (event.type === "terminal.output") output += event.data;
      },
    );
    try {
      await expect.poll(() => output, { timeout: 60_000 }).toMatch(/\$ /);
      manager.input(
        terminalId,
        `python -c 'import os,json; print("CT_"+"IDENTITY:"+json.dumps({"uid":os.getuid(),"cwd":os.getcwd()}))'\r`,
      );
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toMatch(/CT_IDENTITY:\{/);
      const identity = JSON.parse(
        /CT_IDENTITY:(\{[^\r\n]+\})/.exec(output)![1]!,
      );
      expect(identity).toEqual({ uid: scope.uid, cwd: scope.guestPath });
      manager.resize(terminalId, 119, 37);
      manager.input(terminalId, "stty size\r");
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toMatch(/37 119\r?\n/);
      manager.input(terminalId, "nano terminal-note.txt\r");
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toContain("GNU nano");
      manager.input(terminalId, "Linux terminal 日本\x0f");
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toMatch(/(?:Write to File|File Name to Write):/);
      manager.input(terminalId, "\r");
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toMatch(/Wrote \d+ line/);
      manager.input(terminalId, "\x18");
      manager.input(
        terminalId,
        `python -c 'import pathlib; print("CT_"+"NANO:"+pathlib.Path("terminal-note.txt").read_bytes().hex())'\r`,
      );
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toMatch(/CT_NANO:[a-f0-9]+/);
      const bytes = /CT_NANO:([a-f0-9]+)/.exec(output)![1]!;
      expect(Buffer.from(bytes, "hex").toString()).toBe(
        "Linux terminal 日本\n",
      );
      manager.input(
        terminalId,
        `python -u -c 'import time; print("CT_"+"BUSY",flush=True); time.sleep(300)'\r`,
      );
      await expect.poll(() => output, { timeout: 20_000 }).toContain("CT_BUSY");
      manager.input(terminalId, "\x03");
      manager.input(terminalId, `python -c 'print("CT_"+"INTERRUPTED")'\r`);
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toContain("CT_INTERRUPTED");
      manager.input(terminalId, "exit 0\r");
      expect(await opened).toMatchObject({ status: "exited", exitCode: 0 });
      const recoveryId = randomUUID();
      const recovery = await launcher.prepare(
        recoveryId,
        execution,
        scope.guestPath,
        90,
        28,
        core.serverId,
      );
      const command = osTerminalBridgeCommand(recovery.launch);
      const spawn = () =>
        pty.spawn(command.command, command.args, {
          cwd: recovery.cwd,
          cols: 90,
          rows: 28,
          env: process.env as Record<string, string>,
          name: "xterm-256color",
        });
      let remoteOutput = "";
      const first = spawn();
      first.onData((data) => {
        remoteOutput += data;
      });
      const firstExit = new Promise<void>((resolve) =>
        first.onExit(() => resolve()),
      );
      await expect.poll(() => remoteOutput, { timeout: 30_000 }).toMatch(/\$ /);
      first.write(
        `python -c 'import pathlib; p=pathlib.Path("terminal-once.txt"); p.write_text(p.read_text()+"once\\n" if p.exists() else "once\\n"); print("CT_"+"ONCE")'\r`,
      );
      await expect
        .poll(() => remoteOutput, { timeout: 20_000 })
        .toContain("CT_ONCE");
      const admitted = JSON.parse(
        await readFile(path.join(recovery.cwd, "native.json"), "utf8"),
      );
      process.kill(first.pid, "SIGKILL");
      await firstExit;
      expect(osTerminalOutcome(recovery.launch)).toBe("unknown");
      const descriptorBefore = JSON.parse(
        await readFile(recovery.launch.configurationFile, "utf8"),
      );
      const independent = new OsExecutorConnection(
        transport,
        descriptorBefore.binding,
      );
      await independent.request<{ sessionId: string }>("initialize", {
        clientName: "terminal-independent",
        resumeSessionId: null,
      });
      independent.notify("initialized");
      const independentId = randomUUID();
      await independent.request("process/start", {
        processId: independentId,
        argv: ["/bin/sleep", "300"],
        cwd: `file://${scope.guestPath}`,
        env: {},
        tty: false,
        arg0: null,
        sandbox: null,
      });
      const second = spawn();
      let resumedOutput = "";
      second.onData((data) => {
        resumedOutput += data;
      });
      const secondExit = new Promise<void>((resolve) =>
        second.onExit(() => resolve()),
      );
      try {
        await expect
          .poll(() => resumedOutput, { timeout: 30_000 })
          .toContain("CT_ONCE");
        expect(
          JSON.parse(
            await readFile(path.join(recovery.cwd, "native.json"), "utf8"),
          ),
        ).toEqual(admitted);
        second.write(
          `python -c 'import pathlib; print("CT_"+"COUNT:"+str(pathlib.Path("terminal-once.txt").read_text().count("once")))'\r`,
        );
        await expect
          .poll(() => resumedOutput, { timeout: 20_000 })
          .toContain("CT_COUNT:1");
        const rootCommand = `sudo -n python -u -c 'import os,subprocess,time,json; child=subprocess.Popen(["sleep","300"],start_new_session=True); print("CT_"+"TREE:"+json.dumps([os.getpid(),child.pid]),flush=True); time.sleep(300)'`;
        second.write(rootCommand + "\r");
        await expect
          .poll(() => resumedOutput, { timeout: 20_000 })
          .toMatch(/CT_TREE:\[[0-9]+, [0-9]+\]/);
        const rootPids = JSON.parse(
          /CT_TREE:(\[[0-9]+, [0-9]+\])/.exec(resumedOutput)![1]!,
        ) as number[];
        // Native termination, rather than closing the desktop, owns cancellation.
        second.kill("SIGTERM");
        await secondExit;
        expect(osTerminalOutcome(recovery.launch)).toBe("interrupted");
        const actualCleanup = await runGuestProcess(
          independent,
          [
            "/usr/bin/python3",
            "-c",
            `import pathlib,time,json; pids=${JSON.stringify(rootPids)}; time.sleep(.2); print(json.dumps([pathlib.Path('/proc/'+str(pid)).exists() for pid in pids]))`,
          ],
          scope.guestPath,
        );
        expect(JSON.parse(actualCleanup.stdout)).toEqual([false, false]);
        expect(
          await independent.request("process/read", {
            processId: independentId,
            afterSeq: null,
            maxBytes: 65536,
            waitMs: 0,
          }),
        ).toMatchObject({ exited: false });
      } finally {
        try {
          process.kill(second.pid, "SIGTERM");
        } catch {}
        await independent
          .request("process/terminate", { processId: independentId })
          .catch(() => {});
        await independent.close();
      }
      const descriptor = JSON.parse(
        await readFile(recovery.launch.configurationFile, "utf8"),
      );
      const observe = new OsExecutorConnection(transport, descriptor.binding);
      try {
        const initialized = await observe.request<{ sessionId: string }>(
          "initialize",
          {
            clientName: "terminal-observer",
            resumeSessionId: admitted.sessionId,
          },
        );
        observe.notify("initialized");
        expect(initialized.sessionId).toBe(admitted.sessionId);
        expect(
          await observe.request("process/read", {
            processId: admitted.processId,
            afterSeq: null,
            maxBytes: 65536,
            waitMs: 0,
          }),
        ).toMatchObject({ exited: true, closed: true });
      } finally {
        await observe.close();
      }
      // A valid resumed session with an uncertain process handle cannot launch
      // a replacement shell, even if a caller explicitly reconnects.
      const missing = await launcher.prepare(
        randomUUID(),
        execution,
        scope.guestPath,
        90,
        28,
        core.serverId,
      );
      const missingDescriptor = JSON.parse(
        await readFile(missing.launch.configurationFile, "utf8"),
      );
      await writeFile(
        path.join(missing.cwd, "native.json"),
        JSON.stringify({
          ...admitted,
          identity: missingDescriptor.identity,
          processId: randomUUID(),
        }),
        { mode: 0o600 },
      );
      const missingCommand = osTerminalBridgeCommand(missing.launch);
      const unknown = pty.spawn(missingCommand.command, missingCommand.args, {
        cwd: missing.cwd,
        cols: 90,
        rows: 28,
        env: process.env as Record<string, string>,
        name: "xterm-256color",
      });
      let unknownOutput = "";
      unknown.onData((data) => {
        unknownOutput += data;
      });
      await new Promise<void>((resolve) => unknown.onExit(() => resolve()));
      expect(unknownOutput).toContain("outcome is unknown");
      expect(osTerminalOutcome(missing.launch)).toBe("unknown");
      expect(
        JSON.parse(
          await readFile(path.join(missing.cwd, "native.json"), "utf8"),
        ).processId,
      ).not.toBe(admitted.processId);
      const orphanId = randomUUID();
      const orphan = await launcher.prepare(
        orphanId,
        execution,
        scope.guestPath,
        90,
        28,
        core.serverId,
      );
      const orphanCommand = osTerminalBridgeCommand(orphan.launch);
      const orphanPty = pty.spawn(orphanCommand.command, orphanCommand.args, {
        cwd: orphan.cwd,
        cols: 90,
        rows: 28,
        env: process.env as Record<string, string>,
        name: "xterm-256color",
      });
      let orphanOutput = "";
      orphanPty.onData((data) => {
        orphanOutput += data;
      });
      const orphanExit = new Promise<void>((resolve) =>
        orphanPty.onExit(() => resolve()),
      );
      await expect.poll(() => orphanOutput, { timeout: 30_000 }).toMatch(/\$ /);
      orphanPty.write("sleep 300\r");
      process.kill(orphanPty.pid, "SIGKILL");
      await orphanExit;
      expect(osTerminalOutcome(orphan.launch)).toBe("unknown");
      const restartedLauncher = new OsTerminalLauncher(directory, controller, {
        ownerId: () => ownerId,
        serverIdentity: () => core.serverId,
      });
      await restartedLauncher.close(orphanId);
      expect(osTerminalOutcome(orphan.launch)).toBe("interrupted");
      await restartedLauncher.close(orphanId); // already completed, no new process
      await expect(
        launcher.prepare(
          terminalId,
          execution,
          scope.guestPath + "/other",
          90,
          28,
          core.serverId,
        ),
      ).rejects.toThrow(/captured source or directory changed/);
      await expect(
        launcher.prepare(
          terminalId,
          {
            ...execution,
            scope: { ...executionScope, runtimeGeneration: randomUUID() },
          },
          scope.guestPath,
          90,
          28,
          core.serverId,
        ),
      ).rejects.toThrow(/changed/);
    } finally {
      manager.closeAll();
      await opened.catch(() => {});
      await executorControl(transport, ["close", guestWorkspaceId]);
    }
  }, 180_000);
});
