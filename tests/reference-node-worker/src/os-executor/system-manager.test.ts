import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  workerCommandSchema,
  type CantripOsSystemOperationCommand,
  type CantripOsSystemOperationResult,
} from "@cantrip/protocol";
import { decryptCantripOsSystemOperationResult } from "@cantrip/crypto";
import { CantripOsSystemManager } from "./system-manager.js";
import { systemFixture } from "./system-test-fixture.js";
import {
  captureAdmission,
  readSystemJob,
  systemOperationContext,
  systemJobPaths,
} from "./system-job.js";
import { writeOsOperationRecord } from "./operation-files.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = systemFixture(),
    directory = await mkdtemp(join(tmpdir(), "cantrip-system-worker-"));
  directories.push(directory);
  const manager = () =>
    new CantripOsSystemManager(
      directory,
      f.scope.workerId,
      f.keys,
      async () => f.engine,
    );
  const transport = { kind: "docker" as const, container: f.name };
  const status = (await manager().handle({
    type: "cantrip-os.system.status",
    scope: f.scope,
    transport,
  })) as { target: any };
  const capture: Extract<
    CantripOsSystemOperationCommand,
    { action: "capture" }
  > = {
    type: "cantrip-os.system.capture",
    action: "capture",
    mode: "execute",
    operationId: randomUUID(),
    checkpointId: randomUUID(),
    resumeOriginal: true,
    scope: f.scope,
    transport,
    target: status.target,
  };
  const result = (command: CantripOsSystemOperationCommand) =>
    manager().handle(command) as Promise<CantripOsSystemOperationResult | null>;
  return { ...f, directory, manager, capture, result };
}
describe("Worker system command routing", () => {
  it("never advertises private linked-source snapshots as reusable bases, including stale list labels", async () => {
    const f = await fixture();
    const command = {
      type: "cantrip-os.system.status" as const,
      scope: f.scope,
      transport: f.capture.transport,
    };
    expect(await f.manager().handle(command)).toMatchObject({
      bases: [{ imageId: f.baseId }],
    });
    const image = f.images.get(f.baseId)!;
    image.Config.Labels["io.cantrip.os.source-mounts"] = JSON.stringify({
      bindings: [],
    });
    expect(await f.manager().handle(command)).toMatchObject({ bases: [] });
    const request = f.engine.request.bind(f.engine);
    f.engine.request = async (method, path, ...options) => {
      if (path.startsWith("/images/json"))
        return [
          { Id: f.baseId, Labels: { "io.cantrip.os": "foundation" } },
        ] as never;
      return request(method, path, ...options);
    };
    expect(await f.manager().handle(command)).toMatchObject({ bases: [] });
    expect(f.effects).toEqual([]);
  });
  it("can continue after keys lock while preparing the child capture admission", async () => {
    const f = await fixture(),
      manager = f.manager();
    const run = manager.captures.run.bind(manager.captures);
    manager.captures.run = async (...args) => {
      if (args[1] === "prepare") f.lock();
      return run(...args);
    };
    await expect(manager.handle(f.capture)).rejects.toThrow("grant");
    const record = await readSystemJob(f.directory, {
      scope: f.capture.scope,
      operationId: f.capture.operationId,
      targetGeneration: f.capture.target.generation,
    });
    expect(record?.captureRequested).toBe(false);
    expect(f.effects).toEqual([]);
    f.unlock();
    expect((await f.result({ ...f.capture, mode: "observe" }))?.state).toBe(
      "unknown",
    );
    expect(f.effects).toEqual([]);
    expect((await f.result({ ...f.capture, mode: "continue" }))?.state).toBe(
      "ready",
    );
    expect(f.effects.filter((x) => x.path.startsWith("/commit?"))).toHaveLength(
      1,
    );
  });
  it("prepares durably without guest effects and requires explicit continuation", async () => {
    const f = await fixture();
    const prepared = await f.result({ ...f.capture, mode: "prepare" });
    expect(prepared).toMatchObject({ state: "running", phase: "prepared" });
    expect(f.effects).toEqual([]);
    expect(await f.result({ ...f.capture, mode: "observe" })).toEqual(prepared);
    expect(await f.result({ ...f.capture, mode: "prepare" })).toEqual(prepared);
    expect(f.effects).toEqual([]);
    expect((await f.result({ ...f.capture, mode: "continue" }))?.state).toBe(
      "ready",
    );
  });
  it("reports an unattached identity only for the completed exact physical recovery target", async () => {
    const f = await fixture();
    const command: CantripOsSystemOperationCommand = {
      type: "cantrip-os.system.replace",
      action: "replace",
      mode: "execute",
      operationId: randomUUID(),
      scope: f.scope,
      transport: f.capture.transport,
      target: f.capture.target,
      source: { kind: "base", imageId: f.baseId },
      startTarget: true,
    };
    const result = await f.result(command),
      guest = randomUUID();
    expect(result?.state).toBe("ready");
    const candidate = f.containers.get(result!.root!.targetContainerId!)!.files;
    candidate.set(
      "/etc/cantrip-os/executor.json",
      f.files.get("/etc/cantrip-os/executor.json")!,
    );
    candidate.set(
      f.identityPath,
      Buffer.from(
        JSON.stringify({ ...f.identity, instance_id: guest, attachment: null }),
      ),
    );
    const status = {
      type: "cantrip-os.system.status" as const,
      scope: f.scope,
      transport: f.capture.transport,
      target: f.capture.target,
      recovery: {
        operationId: command.operationId,
        scope: command.scope,
        targetGeneration: command.target.generation,
      },
    };
    const effects = f.effects.length;
    expect(await f.manager().handle(status)).toMatchObject({
      target: null,
      enrollment: {
        containerId: result!.root!.targetContainerId,
        guestInstanceId: guest,
      },
    });
    await expect(
      f.manager().handle({
        ...status,
        recovery: { ...status.recovery, operationId: randomUUID() },
      }),
    ).rejects.toThrow("No completed original");
    candidate.set(
      f.identityPath,
      Buffer.from(
        JSON.stringify({
          ...f.identity,
          instance_id: guest,
          attachment: { owner_id: "foreign", worker_id: f.scope.workerId },
        }),
      ),
    );
    await expect(f.manager().handle(status)).rejects.toThrow(
      "identity changed",
    );
    expect(f.effects).toHaveLength(effects);
  });
  async function reserve(
    f: Awaited<ReturnType<typeof fixture>>,
    command: CantripOsSystemOperationCommand,
    claimed: boolean,
  ) {
    const at = new Date().toISOString();
    await writeOsOperationRecord(
      systemJobPaths(f.directory, command.scope, command.operationId).file,
      {
        version: 1,
        command,
        state: "running",
        phase: "reserved",
        startedAt: at,
        updatedAt: at,
        validated: false,
        captureRequested: command.action === "capture" && claimed,
        hostRequested: command.action !== "capture" && claimed,
        capture: null,
        stage: null,
        host: null,
        root: null,
        protectedResult: null,
        diagnostic: null,
      },
      true,
    );
  }
  it("continues an unrequested capture but never recreates a claimed missing capture or host admission", async () => {
    const f = await fixture();
    await reserve(f, f.capture, false);
    expect((await f.result({ ...f.capture, mode: "observe" }))?.state).toBe(
      "unknown",
    );
    expect(f.effects).toEqual([]);
    expect((await f.result({ ...f.capture, mode: "continue" }))?.state).toBe(
      "ready",
    );
    const g = await fixture();
    await reserve(g, g.capture, true);
    expect((await g.result({ ...g.capture, mode: "continue" }))?.state).toBe(
      "unknown",
    );
    const replace: CantripOsSystemOperationCommand = {
      type: "cantrip-os.system.replace",
      action: "replace",
      mode: "execute",
      operationId: randomUUID(),
      scope: g.scope,
      transport: g.capture.transport,
      target: g.capture.target,
      source: { kind: "base", imageId: g.baseId },
      startTarget: true,
    };
    await reserve(g, replace, true);
    expect((await g.result({ ...replace, mode: "continue" }))?.state).toBe(
      "unknown",
    );
    expect(g.effects).toEqual([]);
  });
  it("can administer the proven container after its own identity/config files break", async () => {
    const f = await fixture();
    f.files.set("/etc/cantrip-os/executor.json", Buffer.from("broken"));
    f.files.set(f.identityPath, Buffer.from("broken"));
    expect((await f.result(f.capture))?.state).toBe("ready");
  });
  it("captures, authenticates a replacement, rolls back and retains private immutable results across Manager restart", async () => {
    const f = await fixture();
    expect(workerCommandSchema.parse(f.capture)).toEqual(f.capture);
    const captured = await f.result(f.capture);
    expect(captured?.state).toBe("ready");
    const source = captureAdmission(f.capture);
    const replace: CantripOsSystemOperationCommand = {
      type: "cantrip-os.system.replace",
      action: "replace",
      mode: "execute",
      operationId: randomUUID(),
      scope: f.scope,
      transport: f.capture.transport,
      target: f.capture.target,
      startTarget: true,
      source: { kind: "checkpoint", capture: source },
    };
    const replaced = await f.result(replace);
    expect(replaced?.state).toBe("ready");
    expect(replaced?.root?.targetContainerId).not.toBe(f.rootId);
    const rollback: CantripOsSystemOperationCommand = {
      type: "cantrip-os.system.rollback",
      action: "rollback",
      mode: "execute",
      operationId: randomUUID(),
      scope: f.scope,
      transport: f.capture.transport,
      target: f.capture.target,
      startTarget: true,
      replacement: {
        operationId: replace.operationId,
        scope: f.scope,
        targetGeneration: replace.target.generation,
      },
    };
    const undone = await f.result(rollback);
    expect(undone?.state).toBe("ready");
    expect(undone?.root?.targetContainerId).toBe(f.rootId);
    const count = f.effects.length;
    expect(await f.result(rollback)).toEqual(undone);
    expect(f.effects.length).toBe(count);
    const clear = await decryptCantripOsSystemOperationResult({
      context: systemOperationContext(replace),
      componentKey: f.key,
      keyRevision: 1,
      envelope: replaced!.protectedResult!,
    });
    expect(clear.command.action).toBe("replace");
    expect(clear.replacement).toBeTruthy();
    expect(JSON.stringify(replaced)).not.toContain("PRIVATE_ROOT_TAR");
    f.lock();
    f.engine.request = async () => {
      throw new Error("Docker is unavailable");
    };
    expect(await f.result({ ...rollback, mode: "observe" })).toEqual(undone);
  });
  it("does not dispatch after the owning account changes during target inspection", async () => {
    const f = await fixture(),
      inspect = f.engine.inspect.bind(f.engine);
    f.engine.inspect = async <T>(
      ...args: Parameters<typeof inspect>
    ): Promise<T> => {
      const value = await inspect<T>(...args);
      f.changeOwner();
      return value;
    };
    await expect(f.result(f.capture)).rejects.toThrow("another Worker");
    expect(f.effects).toEqual([]);
  });
  it("observes a lost creation and continues only unrequested root transitions", async () => {
    const f = await fixture();
    await f.result(f.capture);
    const command: CantripOsSystemOperationCommand = {
      type: "cantrip-os.system.replace",
      action: "replace",
      mode: "execute",
      operationId: randomUUID(),
      scope: f.scope,
      transport: f.capture.transport,
      target: f.capture.target,
      startTarget: true,
      source: { kind: "checkpoint", capture: captureAdmission(f.capture) },
    };
    f.lose("create");
    expect((await f.result(command))?.state).toBe("unknown");
    const count = f.effects.length;
    await f.result({ ...command, mode: "observe" });
    expect(f.effects.length).toBe(count);
    expect((await f.result({ ...command, mode: "continue" }))?.state).toBe(
      "ready",
    );
    expect(f.effects.filter((e) => e.action === "create")).toHaveLength(1);
  });
  it("rejects changed admissions, foreign attachments and missing grants before guest effects", async () => {
    const f = await fixture();
    await f.result(f.capture);
    const count = f.effects.length;
    await expect(
      f.result({ ...f.capture, resumeOriginal: false }),
    ).rejects.toThrow("immutable admission");
    f.changeOwner();
    await expect(f.result({ ...f.capture, mode: "observe" })).rejects.toThrow(
      "another Worker",
    );
    expect(f.effects.length).toBe(count);
    const g = await fixture();
    g.lock();
    await expect(g.result(g.capture)).rejects.toThrow("grant");
    expect(g.effects).toEqual([]);
    g.unlock();
    expect((await g.result({ ...g.capture, mode: "observe" }))?.state).toBe(
      "unknown",
    );
    expect(g.effects).toEqual([]);
    expect((await g.result({ ...g.capture, mode: "continue" }))?.state).toBe(
      "ready",
    );
  });
});
