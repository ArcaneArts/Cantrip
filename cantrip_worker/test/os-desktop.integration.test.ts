import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type {
  CantripOsDesktopScope,
  CantripOsDesktopWorkerCommand,
  CantripOsGuestDesktopTarget,
} from "@cantrip/protocol";
import { CantripOsController } from "../src/os-executor/controller.js";
import {
  CapturedDesktopDriver,
  type DesktopDriver,
} from "../src/os-executor/desktop-driver.js";
import { CantripOsDesktopManager } from "../src/os-executor/desktop.js";
import {
  executorControl,
  OsExecutorConnection,
  OsExecutorDeliveryError,
} from "../src/os-executor/connection.js";
import { runGuestProcess } from "../src/os-executor/process.js";

const container = process.env.CANTRIP_OS_TEST_DESKTOP_CONTAINER;
it.skipIf(!container)(
  "manages real desktops through the pinned native executor and recovers without replay",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-desktop-actual-"),
    );
    const workerId = "00000000-0000-4000-8000-000000000002",
      ownerId = "00000000-0000-4000-8000-000000000001";
    const transport = { kind: "docker" as const, container: container! };
    const controller = new CantripOsController(directory, workerId);
    const actual = (await controller.handle({
      type: "cantrip-os.inspect",
      workerId,
      ownerId,
      transport,
    })) as {
      guestInstanceId: string;
      runtimeGeneration: string;
    };
    const base = {
      serverId: "desktop-actual-acceptance",
      ownerId,
      workerId,
      instanceId: randomUUID(),
      guestInstanceId: actual.guestInstanceId,
      runtimeGeneration: actual.runtimeGeneration,
      attachmentGeneration: randomUUID(),
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: base,
      transport,
    });
    const profile = `desk-ctl-${randomUUID().slice(0, 8)}`;
    const created = (await controller.handle({
      type: "cantrip-os.workspaces.create",
      scope: base,
      transport,
      operationId: randomUUID(),
      guestWorkspaceId: profile,
    })) as {
      state: string;
      receipt: {
        kind: string;
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    expect(created.state).toBe("ready");
    const workspace = created.receipt.workspace;
    const scope: CantripOsDesktopScope = {
      ...base,
      workspaceId: randomUUID(),
      guestWorkspaceId: profile,
      ...workspace,
    };
    const real = new CapturedDesktopDriver(controller);
    let dropReply = false,
      executes = 0;
    const driver: DesktopDriver = {
      async run(command, args, hooks) {
        if (args[0] === "desktop-execute") executes++;
        const result = await real.run(command, args, hooks);
        if (args[0] === "desktop-execute" && dropReply) {
          dropReply = false;
          throw new OsExecutorDeliveryError(
            "Actual desktop reply deliberately dropped",
          );
        }
        return result;
      },
    };
    let manager = new CantripOsDesktopManager(directory, workerId, driver);
    const current = async () =>
      (await manager.handle({
        type: "cantrip-os.desktop.status",
        scope,
        transport,
      })) as CantripOsGuestDesktopTarget;
    const admit = async (action: "start" | "stop" | "restart") =>
      ({
        type: "cantrip-os.desktop.operation",
        mode: "execute",
        scope,
        transport,
        action,
        operationId: randomUUID(),
        targetGeneration: randomUUID(),
        desktopTarget: await current(),
      }) as Extract<
        CantripOsDesktopWorkerCommand,
        { type: "cantrip-os.desktop.operation" }
      >;
    expect((await current()).status).toBe("stopped");
    const binding = await controller.captureAdministrativeBinding(
      transport,
      scope,
    );
    const connection = new OsExecutorConnection(transport, binding);
    const processId = randomUUID();
    const proofs: unknown[] = [];
    try {
      await connection.request("initialize", {
        clientName: "independent-desktop-proof",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      await connection.request("process/start", {
        processId,
        argv: [
          "python3",
          "-c",
          "import os,time; print(os.getuid(),flush=True); time.sleep(150)",
        ],
        cwd: `file://${scope.homeGuestPath}`,
        env: {},
        tty: false,
        pipeStdin: false,
        arg0: null,
        sandbox: null,
      });
      const marker = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          "import pathlib; p=pathlib.Path('native-desktop-µ.txt'); p.write_text('native process retained 日本語\\n'); p.chmod(0o751)",
        ],
        scope.homeGuestPath,
      );
      expect(marker.exitCode).toBe(0);
      for (const action of ["start", "stop", "start"] as const) {
        const command = await admit(action);
        const result = await manager.handle(command);
        expect(result?.state).toBe("ready");
        expect(result?.observation?.status).toBe(
          action === "stop" ? "stopped" : "running",
        );
        const independent = await connection.request<{
          exited: boolean;
          chunks: Array<{ chunk: string }>;
        }>("process/read", {
          processId,
          afterSeq: null,
          maxBytes: 65536,
          waitMs: 0,
        });
        expect(independent.exited).toBe(false);
        expect(
          Buffer.concat(
            independent.chunks.map((chunk) =>
              Buffer.from(chunk.chunk, "base64"),
            ),
          ).toString(),
        ).toContain(String(scope.uid));
        const retained = await controller.captureAdministrativeBinding(
          transport,
          scope,
        );
        expect(retained.executor_generation).toBe(binding.executor_generation);
        proofs.push({
          command,
          result,
          independentAlive: true,
          executorGenerationRetained: true,
        });
      }
      const restart = await admit("restart");
      dropReply = true;
      expect((await manager.handle(restart))?.state).toBe("unknown");
      manager = new CantripOsDesktopManager(directory, workerId, driver);
      const recovered = await manager.handle({
        ...restart,
        mode: "observe",
      } as CantripOsDesktopWorkerCommand);
      expect(recovered?.state).toBe("ready");
      expect(recovered?.receipt?.after.generation).toBe(
        (
          restart as Extract<
            CantripOsDesktopWorkerCommand,
            { type: "cantrip-os.desktop.operation" }
          >
        ).desktopTarget.generation + 1,
      );
      const once = executes;
      expect((await manager.handle(restart))?.receipt).toEqual(
        recovered?.receipt,
      );
      const empty = new CantripOsDesktopManager(
        await mkdtemp(path.join(tmpdir(), "cantrip-desktop-empty-")),
        workerId,
        driver,
      );
      expect(
        (
          await empty.handle({
            ...restart,
            mode: "observe",
          } as CantripOsDesktopWorkerCommand)
        )?.receipt,
      ).toEqual(recovered?.receipt);
      expect(executes).toBe(once);
      const file = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          "import pathlib; p=pathlib.Path('native-desktop-µ.txt'); assert p.read_text()=='native process retained 日本語\\n'; assert p.stat().st_mode&511==489; print(p.stat().st_uid)",
        ],
        scope.homeGuestPath,
      );
      expect(file.exitCode).toBe(0);
      expect(file.stdout.trim()).toBe(String(scope.uid));
      proofs.push({
        restart,
        recovered,
        executeCount: executes,
        replyLossAndEmptyWorkerJournalObservedWithoutReplay: true,
        retainedFile: true,
      });
    } finally {
      await connection
        .request("process/terminate", { processId })
        .catch(() => {});
      await connection.close();
      await manager.handle(await admit("stop")).catch(() => {});
      await executorControl(transport, ["close", profile]);
      await writeFile(
        path.join(directory, "proof.json"),
        JSON.stringify(proofs, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log(
        `Actual native desktop proof: ${path.join(directory, "proof.json")}`,
      );
    }
  },
);
