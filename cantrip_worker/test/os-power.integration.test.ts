import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalDocker, DockerDeliveryError } from "@cantrip/os-host";
import {
  cantripOsObservedInstanceSchema,
  cantripOsPowerOperationResultSchema,
  cantripOsPowerObservationSchema,
} from "@cantrip/protocol";
import { CantripOsController } from "../src/os-executor/controller.js";
import { CantripOsPowerManager } from "../src/os-executor/power.js";

const execute = promisify(execFile);
const container = process.env.CANTRIP_OS_TEST_CONTAINER;
it.skipIf(!container)(
  "retains actual Docker state and resumes admitted power after Manager loss without guest or mutation replay",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-power-manager-"));
    const workerId = "00000000-0000-4000-8000-000000000002",
      ownerId = "00000000-0000-4000-8000-000000000001";
    const controller = new CantripOsController(directory, workerId);
    const transport = { kind: "docker" as const, container: container! };
    const inspected = cantripOsObservedInstanceSchema.parse(
      await controller.handle({
        type: "cantrip-os.inspect",
        ownerId,
        workerId,
        transport,
      }),
    );
    expect(inspected.attachment).toEqual({ ownerId, workerId });
    expect(inspected.powerTarget?.kind).toBe("docker");
    const engine = await LocalDocker.current();
    const actual = await engine.inspect<{
      Id: string;
      State: { Running: boolean };
    }>(container!);
    expect(inspected.powerTarget?.containerId).toBe(actual.Id);
    const powerTarget = {
      kind: "docker" as const,
      generation: randomUUID(),
      containerId: actual.Id,
    };
    const scope = {
      ownerId,
      workerId,
      serverId: "power-manager-acceptance",
      instanceId: randomUUID(),
      guestInstanceId: inspected.guestInstanceId,
      attachmentGeneration: randomUUID(),
      runtimeGeneration: inspected.runtimeGeneration,
    };
    const command = {
      type: "cantrip-os.power.operation" as const,
      mode: "execute" as const,
      scope,
      transport,
      powerTarget,
      operationId: randomUUID(),
      action: "stop" as const,
    };
    const marker = `/etc/cantrip-power-manager-${randomUUID()}`;
    await execute("docker", [
      "exec",
      actual.Id,
      "python3",
      "-c",
      "from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(b'power manager retained bytes');p.chmod(0o640)",
      marker,
    ]);
    let posts = 0,
      drop = false;
    const carrier = {
      inspect: engine.inspect.bind(engine),
      request: (async (...args: Parameters<typeof engine.request>) => {
        const result = await engine.request(...args);
        if (args[0] === "POST") {
          posts++;
          if (drop) {
            drop = false;
            throw new DockerDeliveryError(
              "Acceptance: lost actual mutation response",
            );
          }
        }
        return result;
      }) as typeof engine.request,
    };
    try {
      const manager = new CantripOsPowerManager(
        directory,
        workerId,
        async () => carrier,
      );
      const stopped = cantripOsPowerOperationResultSchema.parse(
        await manager.handle(command),
      );
      expect(stopped.state, JSON.stringify(stopped)).toBe("ready");
      expect(stopped.observation?.running).toBe(false);
      await expect(
        controller.handle({
          type: "cantrip-os.inspect",
          ownerId,
          workerId,
          transport,
        }),
      ).rejects.toThrow();
      const afterLoss = new CantripOsPowerManager(
        directory,
        workerId,
        async () => carrier,
      );
      const stopHistory = cantripOsPowerOperationResultSchema.parse(
        await afterLoss.handle({ ...command, mode: "observe" }),
      );
      expect(stopHistory.state).toBe("ready");
      expect(stopHistory.observation?.running).toBe(false);
      expect(posts).toBe(1);
      const started = cantripOsPowerOperationResultSchema.parse(
        await afterLoss.handle({
          ...command,
          operationId: randomUUID(),
          action: "start",
        }),
      );
      expect(started.state, JSON.stringify(started)).toBe("ready");
      expect(started.observation?.running).toBe(true);
      await expect
        .poll(
          async () => {
            try {
              return cantripOsObservedInstanceSchema.parse(
                await controller.handle({
                  type: "cantrip-os.inspect",
                  ownerId,
                  workerId,
                  transport,
                }),
              ).runtimeGeneration;
            } catch {
              return null;
            }
          },
          { timeout: 30_000, interval: 250 },
        )
        .not.toBeNull();
      const current = cantripOsObservedInstanceSchema.parse(
        await controller.handle({
          type: "cantrip-os.inspect",
          ownerId,
          workerId,
          transport,
        }),
      );
      expect(current.guestInstanceId).toBe(inspected.guestInstanceId);
      expect(current.runtimeGeneration).not.toBe(inspected.runtimeGeneration);
      const restart = {
        ...command,
        operationId: randomUUID(),
        action: "restart" as const,
      };
      drop = true;
      const lost = cantripOsPowerOperationResultSchema.parse(
        await afterLoss.handle(restart),
      );
      expect(lost.state, JSON.stringify(lost)).toBe("unknown");
      const resumed = new CantripOsPowerManager(
        directory,
        workerId,
        async () => carrier,
      );
      const observed = cantripOsPowerOperationResultSchema.parse(
        await resumed.handle({ ...restart, mode: "observe" }),
      );
      expect(observed.state, JSON.stringify(observed)).toBe("ready");
      expect(observed.receipt?.completionEvidence).toBe("observed-state");
      await resumed.handle(restart);
      expect(posts).toBe(3);
      await expect(
        resumed.handle({ ...restart, action: "stop" }),
      ).rejects.toThrow("different admission");
      expect(posts).toBe(3);
      const offline = new CantripOsPowerManager(
        directory,
        workerId,
        async () => {
          throw new Error("Carrier unavailable fixture");
        },
      );
      const saved = cantripOsPowerOperationResultSchema.parse(
        await offline.handle({ ...restart, mode: "observe" }),
      );
      expect(saved.state).toBe("ready");
      expect(saved.observation).toBeNull();
      expect(saved.observationError).toBeTruthy();
      const status = cantripOsPowerObservationSchema.parse(
        await resumed.handle({
          type: "cantrip-os.power.status",
          scope,
          transport,
          powerTarget,
        }),
      );
      expect(status.running).toBe(true);
      const bytes = (
        await execute("docker", [
          "exec",
          actual.Id,
          "python3",
          "-c",
          "from pathlib import Path;import sys,stat;p=Path(sys.argv[1]);assert p.read_bytes()==b'power manager retained bytes';assert stat.S_IMODE(p.stat().st_mode)==0o640;print('retained')",
          marker,
        ])
      ).stdout.trim();
      expect(bytes).toBe("retained");
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase5-instance-power/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      await writeFile(
        new URL(`manager-${scope.instanceId}.json`, artifacts),
        JSON.stringify(
          {
            scope,
            powerTarget,
            directory,
            marker,
            stopped,
            started,
            lost,
            observed,
            saved,
            currentRuntime: current.runtimeGeneration,
            posts,
            retainedRootCustomization: true,
            fullWorkerProductAcceptance: false,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } finally {
      if (
        !(await engine.inspect<{ State: { Running: boolean } }>(actual.Id))
          .State.Running
      )
        await engine.request("POST", `/containers/${actual.Id}/start`);
    }
  },
);
