import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CantripOsController } from "../src/os-executor/controller.js";
import {
  executorControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)("real CantripOS worker command dispatch", () => {
  it("creates a persistent profile/source once, records native provenance and rejects stale generations", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? (JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        ) as OsExecutorTransport)
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const ownerId = "00000000-0000-4000-8000-000000000001",
      workerId = "00000000-0000-4000-8000-000000000002";
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-dispatch-"),
    );
    const controller = new CantripOsController(directory, workerId);
    const observed = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as {
      guestInstanceId: string;
      runtimeGeneration: string;
    };
    const scope = {
      ownerId,
      workerId,
      serverId: "cantrip-dispatch-fixture",
      instanceId: randomUUID(),
      guestInstanceId: observed.guestInstanceId,
      attachmentGeneration: randomUUID(),
      runtimeGeneration: observed.runtimeGeneration,
    };
    await controller.handle({ type: "cantrip-os.attach", scope, transport });
    const guestWorkspaceId = `ctl-${randomUUID().slice(0, 12)}`;
    const create = {
      type: "cantrip-os.workspaces.create" as const,
      scope,
      transport,
      guestWorkspaceId,
      operationId: randomUUID(),
    };
    const profile = (await controller.handle(create)) as {
      state: string;
      receipt: {
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    expect(profile.state).toBe("ready");
    expect(await controller.handle(create)).toEqual(profile);
    const projectSourceId = randomUUID(),
      operationId = randomUUID();
    const sourceScope = {
      ...scope,
      projectId: randomUUID(),
      projectSourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId,
      ...profile.receipt.workspace,
      guestPath: `${profile.receipt.workspace.homeGuestPath}/checkouts/${projectSourceId}`,
      sourceKind: "folder" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
    };
    const provision = {
      type: "cantrip-os.source.provision" as const,
      scope: sourceScope,
      transport,
      operationId,
      intent: {
        mode: "linux-owned" as const,
        source: { kind: "folder" as const },
      },
    };
    try {
      const result = (await controller.handle(provision)) as {
        state: string;
        receipt: { source: { guestPath: string } };
      };
      expect(result.state).toBe("ready");
      expect(result.receipt.source.guestPath).toBe(sourceScope.guestPath);
      expect(await controller.handle(provision)).toEqual(result);
      const privateRecord = await controller.operations.inspect(
        scope,
        operationId,
      );
      expect(privateRecord?.native?.sessionId).toBeTruthy();
      expect(privateRecord?.processes.length).toBeGreaterThan(0);
      const publicRecord = await controller.handle({
        type: "cantrip-os.operation.inspect",
        scope,
        operationId,
      });
      expect(JSON.stringify(publicRecord)).not.toMatch(
        /sessionId|argv|"native"/,
      );
      expect(
        await controller.handle({
          type: "cantrip-os.source.inspect",
          scope: sourceScope,
          transport,
          sourceKind: "folder",
        }),
      ).toMatchObject({
        guestPath: sourceScope.guestPath,
        uid: sourceScope.uid,
      });
      const staleId = randomUUID();
      await expect(
        controller.handle({
          ...provision,
          operationId: staleId,
          scope: { ...sourceScope, runtimeGeneration: randomUUID() },
        }),
      ).rejects.toThrow(/changed/);
      expect(await controller.operations.inspect(scope, staleId)).toBeNull();
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase3-dispatch/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(
          `controller-${transport.kind}-${projectSourceId}.json`,
          artifacts,
        ),
        JSON.stringify({ scope: sourceScope, result, privateRecord }, null, 2),
      );
    } finally {
      await executorControl(transport, ["close", guestWorkspaceId]);
    }
  }, 120_000);
});
