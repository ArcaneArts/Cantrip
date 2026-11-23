import { execFile, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  clearSensitiveBytes,
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import {
  cantripOsBackupPrivateResultSchema,
  cantripOsBackupRequestEnvelopeSchema,
  type CantripOsBackupPrivateResult,
  type CantripOsBackupWorkerCommand,
  type CantripOsBackupWorkspace,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import type { CantripOsDispatchScope } from "@cantrip/protocol";
import { CantripOsController } from "../src/os-executor/controller.js";
import { CantripOsBackupManager } from "../src/os-executor/backup-manager.js";
import {
  executorControl,
  executorCommand,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorTransport,
  type OsExecutorBinding,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import {
  recoveryControl,
  exportRecoveryArchive,
} from "../src/os-executor/recovery-carrier.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
const execute = promisify(execFile);
type Status = {
  instance_id: string;
  generation: string;
  attachment: { owner_id: string; worker_id: string } | null;
};

async function readRetainedFile(transport: OsExecutorTransport, path: string) {
  if (transport.kind === "docker") {
    return (
      await execute("docker", [
        "exec",
        "--user",
        "0",
        "--",
        transport.container,
        "cat",
        "--",
        path,
      ])
    ).stdout;
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return (
    await execute("ssh", [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${transport.knownHostsFile}`,
      "-i",
      transport.identityFile,
      "-p",
      String(transport.port),
      "--",
      `${transport.user}@${transport.host}`,
      ["sudo", "-n", "--", "cat", "--", path].map(quote).join(" "),
    ])
  ).stdout;
}

async function fixture() {
  const source: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
    ? JSON.parse(await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"))
    : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
  const target: OsExecutorTransport = process.env
    .CANTRIP_OS_TEST_RESTORE_TRANSPORT
    ? JSON.parse(
        await readFile(process.env.CANTRIP_OS_TEST_RESTORE_TRANSPORT, "utf8"),
      )
    : process.env.CANTRIP_OS_TEST_RESTORE_CONTAINER
      ? {
          kind: "docker",
          container: process.env.CANTRIP_OS_TEST_RESTORE_CONTAINER,
        }
      : source;
  let status = await executorControl<Status>(source, ["status"]);
  if (!status.attachment)
    status = await executorControl(source, [
      "attach",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  let targetStatus = await executorControl<Status>(target, ["status"]);
  if (!targetStatus.attachment)
    targetStatus = await executorControl(target, [
      "attach",
      status.attachment!.owner_id,
      status.attachment!.worker_id,
    ]);
  expect(targetStatus.attachment).toEqual(status.attachment);
  const directory = await mkdtemp(join(tmpdir(), "cantrip-backup-admissions-"));
  const key = randomBytes(32);
  const serverId = "private-backup-operation-fixture",
    ownerId = status.attachment!.owner_id,
    workerId = status.attachment!.worker_id;
  const instanceIds = new Map([
    [status.instance_id, randomUUID()],
    [targetStatus.instance_id, randomUUID()],
  ]);
  const keys = {
    ownerId: () => ownerId,
    serverIdentity: () => serverId,
    componentKey: (_scope: string, revision = 1) => {
      if (revision !== 1)
        throw new Error("Fixture key revision is unavailable");
      return { key: new Uint8Array(key), keyRevision: revision };
    },
  };
  const calls: string[][] = [];
  const ports = {
    exportArchive: exportRecoveryArchive,
    control: async (input: Parameters<typeof recoveryControl>[0]) => {
      calls.push(input.args);
      return recoveryControl(input);
    },
  };
  const manager = () =>
    new CantripOsBackupManager(
      directory,
      workerId,
      new CantripOsController(directory, workerId),
      keys,
      ports,
    );
  const scope = async (
    transport: OsExecutorTransport,
  ): Promise<CantripOsDispatchScope> => {
    const current = await executorControl<Status>(transport, ["status"]);
    return {
      ownerId,
      workerId,
      serverId,
      instanceId: instanceIds.get(current.instance_id)!,
      guestInstanceId: current.instance_id,
      attachmentGeneration: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: current.generation,
    };
  };
  const workspace = async (
    transport: OsExecutorTransport,
    prefix: string,
  ): Promise<CantripOsBackupWorkspace> => {
    const guestWorkspaceId = `${prefix}-${randomUUID().slice(0, 10)}`;
    const account = await workspaceControl<{
      uid: number;
      gid: number;
      home: string;
    }>(transport, ["create", guestWorkspaceId]);
    return {
      id: randomUUID(),
      guestWorkspaceId,
      uid: account.uid,
      gid: account.gid,
      homeGuestPath: account.home,
    };
  };
  const files = async (
    transport: OsExecutorTransport,
    account: CantripOsBackupWorkspace,
    values?: Map<string, Buffer>,
    readName = ".env",
  ) => {
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      account.guestWorkspaceId,
    ]);
    const connection = new OsExecutorConnection(transport, binding);
    try {
      await connection.request("initialize", {
        clientName: "backup-admission-fixture",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      if (values)
        for (const [name, value] of values)
          await connection.request("fs/writeFile", {
            path: guestFileUri(`${binding.home}/${name}`),
            dataBase64: value.toString("base64"),
            sandbox: null,
          });
      const get = async (name: string) =>
        Buffer.from(
          (
            await connection.request<{ dataBase64: string }>("fs/readFile", {
              path: guestFileUri(`${binding.home}/${name}`),
              sandbox: null,
            })
          ).dataBase64,
          "base64",
        );
      return values ? null : await get(readName);
    } finally {
      await connection.close();
    }
  };
  const request = async (operationId: string, value: unknown) =>
    cantripOsBackupRequestEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ownerId,
        serverId,
        operationId,
        keyRevision: 1,
        componentKey: key,
        direction: "request",
        plaintext: new TextEncoder().encode(JSON.stringify(value)),
      }),
    );
  const openResult = async (
    operationId: string,
    result: Awaited<ReturnType<CantripOsBackupManager["handle"]>>,
  ): Promise<CantripOsBackupPrivateResult> => {
    const plaintext = await decryptCantripOsBackupMessage({
      ownerId,
      serverId,
      operationId,
      keyRevision: 1,
      componentKey: key,
      direction: "response",
      frame: result.protectedResult!,
    });
    try {
      return cantripOsBackupPrivateResultSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  };
  const killAt = async (
    command: CantripOsBackupWorkerCommand,
    pauseAfter: string,
  ) => {
    const config = join(directory, `fixture-${command.operationId}.json`);
    await writeFile(
      config,
      JSON.stringify({
        directory,
        key: key.toString("base64"),
        command,
        pauseAfter,
      }),
      { mode: 0o600 },
    );
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/os-backup-worker.mts", import.meta.url),
      ),
      [config],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let diagnostics = "";
    child.stderr!.on("data", (data: Buffer) => {
      diagnostics = (diagnostics + data.toString()).slice(-4096);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("Worker did not reach its boundary: " + diagnostics),
            ),
          60000,
        );
        child.on("message", (message) => {
          if (
            message &&
            typeof message === "object" &&
            Reflect.get(message, "checkpoint") === pauseAfter
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Worker exited ${code}: ${diagnostics}`));
        });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  };
  return {
    source,
    target,
    scope,
    workspace,
    files,
    directory,
    key,
    keys,
    calls,
    manager,
    request,
    openResult,
    killAt,
    close: async () => {
      key.fill(0);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!enabled)("real Worker backup admissions", () => {
  it("resets selected state and undoes it while retaining writes made after reset", async () => {
    const f = await fixture();
    try {
      const workspace = await f.workspace(f.source, "mr-reset");
      await f.files(
        f.source,
        workspace,
        new Map([
          [".env", Buffer.from("DUMMY_KEEP=original\n")],
          ["reset-me.txt", Buffer.from("private reset value 日本\n")],
        ]),
      );
      const operationId = randomUUID();
      const command = {
        type: "cantrip-os.backup.reset" as const,
        scope: await f.scope(f.source),
        transport: f.source,
        operationId,
        workspace,
        protectedRequest: await f.request(operationId, {
          action: "reset",
          workspaceId: workspace.id,
          paths: ["reset-me.txt"],
        }),
      };
      const result = await f.manager().handle(command);
      expect(result.state).toBe("ready");
      expect(await f.openResult(operationId, result)).toMatchObject({
        action: "reset",
        receipt: {
          reset_paths: ["reset-me.txt"],
          shared_system_state_changed: false,
        },
      });
      expect(await f.files(f.source, workspace)).toEqual(
        Buffer.from("DUMMY_KEEP=original\n"),
      );
      await expect(
        f.files(f.source, workspace, undefined, "reset-me.txt"),
      ).rejects.toThrow();
      await f.files(
        f.source,
        workspace,
        new Map([["later.txt", Buffer.from("AFTER_RESET=retain\n")]]),
      );
      const undoId = randomUUID();
      const undone = await f.manager().handle({
        type: "cantrip-os.backup.rollback",
        operationId: undoId,
        scope: await f.scope(f.source),
        transport: f.source,
        workspace,
        restoreOperationId: operationId,
        protectedRequest: await f.request(undoId, {
          action: "rollback",
          workspaceId: workspace.id,
          restoreOperationId: operationId,
        }),
      });
      expect(undone.state).toBe("ready");
      expect(
        await f.files(f.source, workspace, undefined, "reset-me.txt"),
      ).toEqual(Buffer.from("private reset value 日本\n"));
      const privateUndo = await f.openResult(undoId, undone);
      expect(privateUndo.action).toBe("rollback");
      if (privateUndo.action !== "rollback")
        throw new Error("Missing private undo receipt");
      expect(privateUndo.receipt.retained_replaced_home).toBeTruthy();
      expect(
        await readRetainedFile(
          f.source,
          `${String(privateUndo.receipt.retained_replaced_home)}/later.txt`,
        ),
      ).toBe("AFTER_RESET=retain\n");
      const original = await recoveryControl({
        transport: f.source,
        args: ["inspect", operationId],
      });
      expect(original.state).toBe("reset");
      expect(f.calls.filter((args) => args.includes("reset"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 90_000);

  it("recovers actual whole-home reset after killing its Worker before the reply without a second exchange", async () => {
    const f = await fixture();
    try {
      const workspace = await f.workspace(f.source, "mr-killed");
      await f.files(
        f.source,
        workspace,
        new Map([[".env", Buffer.from("DUMMY_RESET=retained\n")]]),
      );
      const operationId = randomUUID();
      const command = {
        type: "cantrip-os.backup.reset" as const,
        scope: await f.scope(f.source),
        transport: f.source,
        operationId,
        workspace,
        protectedRequest: await f.request(operationId, {
          action: "reset",
          workspaceId: workspace.id,
          paths: ["."],
        }),
      };
      await f.killAt(command, "reset");
      const before = await recoveryControl({
        transport: f.source,
        args: ["inspect", operationId],
      });
      expect(before).toMatchObject({
        version: 2,
        state: "reset",
        maintenance: { released: true },
      });
      const repeated = await f.manager().handle(command);
      expect(repeated.state).toBe("unknown");
      const observed = await f.manager().handle({
        type: "cantrip-os.backup.observe",
        scope: command.scope,
        operationId,
        action: "reset",
        mode: "recover",
      });
      expect(observed.state).toBe("ready");
      expect(await f.openResult(operationId, observed)).toMatchObject({
        action: "reset",
        receipt: before.receipt,
      });
      expect(
        await recoveryControl({
          transport: f.source,
          args: ["inspect", operationId],
        }),
      ).toEqual(before);
      expect(f.calls.filter((args) => args.includes("reset"))).toHaveLength(0);
      await expect(f.files(f.source, workspace)).rejects.toThrow();
      const undoId = randomUUID();
      const undone = await f.manager().handle({
        type: "cantrip-os.backup.rollback",
        operationId: undoId,
        scope: await f.scope(f.source),
        transport: f.source,
        workspace,
        restoreOperationId: operationId,
        protectedRequest: await f.request(undoId, {
          action: "rollback",
          workspaceId: workspace.id,
          restoreOperationId: operationId,
        }),
      });
      expect(undone.state).toBe("ready");
      expect(await f.files(f.source, workspace)).toEqual(
        Buffer.from("DUMMY_RESET=retained\n"),
      );
    } finally {
      await f.close();
    }
  }, 90_000);

  it("continues an already received archive after executor restart with explicit fresh runtime authority", async () => {
    const f = await fixture();
    try {
      const source = await f.workspace(f.source, "mb-continue");
      await f.files(
        f.source,
        source,
        new Map([[".env", Buffer.from("DUMMY_CONTINUE=original\n")]]),
      );
      const captureId = randomUUID(),
        backupScope = await f.scope(f.source);
      expect(
        (
          await f.manager().handle({
            type: "cantrip-os.backup.capture",
            operationId: captureId,
            scope: backupScope,
            transport: f.source,
            workspace: source,
            sources: [],
            protectedRequest: await f.request(captureId, {
              action: "capture",
              workspaceId: source.id,
              label: "Continuation",
              exclusions: [],
            }),
          })
        ).state,
      ).toBe("ready");
      const target = await f.workspace(f.target, "mb-received");
      const restoreId = randomUUID(),
        original = await f.scope(f.target);
      await f.killAt(
        {
          type: "cantrip-os.backup.restore",
          operationId: restoreId,
          scope: original,
          transport: f.target,
          workspace: target,
          backupId: captureId,
          backupScope,
          replace: false,
          protectedRequest: await f.request(restoreId, {
            action: "restore",
            workspaceId: target.id,
            backupId: captureId,
            replace: false,
          }),
        },
        "receive",
      );
      const restart = executorCommand(f.target, ["service", "restart"]);
      await execute(restart.command, restart.args);
      const current = await f.scope(f.target);
      expect(current.runtimeGeneration).not.toBe(original.runtimeGeneration);
      const observe = {
        type: "cantrip-os.backup.observe" as const,
        operationId: restoreId,
        scope: original,
        action: "restore" as const,
      };
      expect(
        (await f.manager().handle({ ...observe, mode: "observe" })).state,
      ).toBe("unknown");
      const before = f.calls.length;
      expect(
        (
          await f.manager().handle({
            ...observe,
            mode: "continue",
            continuationScope: { ...current, guestInstanceId: randomUUID() },
          })
        ).state,
      ).toBe("unknown");
      expect(f.calls).toHaveLength(before);
      const restored = await f
        .manager()
        .handle({ ...observe, mode: "continue", continuationScope: current });
      expect(restored.state).toBe("ready");
      expect(f.calls.some((args) => args.includes("receive"))).toBe(false);
      expect(f.calls.filter((args) => args.includes("restore"))).toHaveLength(
        1,
      );
      expect(await f.files(f.target, target)).toEqual(
        Buffer.from("DUMMY_CONTINUE=original\n"),
      );
    } finally {
      await f.close();
    }
  }, 240000);
  it("persists capture once, restores into another instance/account and rolls back explicit replacement", async () => {
    const f = await fixture();
    try {
      const original = await f.workspace(f.source, "mb-source");
      const values = new Map([
        [".env", Buffer.from("DUMMY_PRIVATE=original\n")],
        ["雪.txt", Buffer.from("Unicode")],
        ["profile.bin", Buffer.alloc(2 * 1_048_576 + 19, 0x63)],
      ]);
      await f.files(f.source, original, values);
      const captureId = randomUUID(),
        originalScope = await f.scope(f.source);
      const capture: CantripOsBackupWorkerCommand = {
        type: "cantrip-os.backup.capture",
        operationId: captureId,
        scope: originalScope,
        transport: f.source,
        workspace: original,
        sources: [],
        protectedRequest: await f.request(captureId, {
          action: "capture",
          workspaceId: original.id,
          label: "Private fixture label",
          exclusions: [],
        }),
      };
      const captured = await f.manager().handle(capture);
      expect(captured.state).toBe("ready");
      const before = f.calls.length;
      expect(await f.manager().handle(capture)).toEqual(captured);
      expect(f.calls.length).toBe(before);
      expect(f.calls.filter((args) => args.includes("capture"))).toHaveLength(
        1,
      );
      expect(JSON.stringify(captured)).not.toContain(original.homeGuestPath);
      expect(JSON.stringify(captured)).not.toContain("Private fixture label");
      expect((await f.openResult(captureId, captured)).action).toBe("capture");

      const destination = await f.workspace(f.target, "mb-new");
      const restoreId = randomUUID();
      const restore: CantripOsBackupWorkerCommand = {
        type: "cantrip-os.backup.restore",
        operationId: restoreId,
        scope: await f.scope(f.target),
        transport: f.target,
        workspace: destination,
        backupId: captureId,
        backupScope: originalScope,
        replace: false,
        protectedRequest: await f.request(restoreId, {
          action: "restore",
          workspaceId: destination.id,
          backupId: captureId,
          replace: false,
        }),
      };
      const restored = await f.manager().handle(restore);
      expect(restored.state).toBe("ready");
      expect(await f.files(f.target, destination)).toEqual(values.get(".env"));
      const restoredPrivate = await f.openResult(restoreId, restored);
      expect(restoredPrivate.action).toBe("restore");
      if (restoredPrivate.action === "restore")
        expect(restoredPrivate.receipt).toMatchObject({
          uid_mapping: { [String(original.uid)]: destination.uid },
        });
      const replacement = await f.workspace(f.target, "mb-replace");
      await f.files(
        f.target,
        replacement,
        new Map([
          [".env", Buffer.from("DUMMY_PRIVATE=destination-original\n")],
        ]),
      );
      const replaceId = randomUUID();
      const replaced = await f.manager().handle({
        ...restore,
        operationId: replaceId,
        scope: await f.scope(f.target),
        workspace: replacement,
        replace: true,
        protectedRequest: await f.request(replaceId, {
          action: "restore",
          workspaceId: replacement.id,
          backupId: captureId,
          replace: true,
        }),
      });
      expect(replaced.state).toBe("ready");
      const rollbackId = randomUUID();
      const rolled = await f.manager().handle({
        type: "cantrip-os.backup.rollback",
        operationId: rollbackId,
        scope: await f.scope(f.target),
        transport: f.target,
        workspace: replacement,
        restoreOperationId: replaceId,
        protectedRequest: await f.request(rollbackId, {
          action: "rollback",
          workspaceId: replacement.id,
          restoreOperationId: replaceId,
        }),
      });
      expect(rolled.state).toBe("ready");
      expect(await f.files(f.target, replacement)).toEqual(
        Buffer.from("DUMMY_PRIVATE=destination-original\n"),
      );
    } finally {
      await f.close();
    }
  }, 240000);

  it("recovers a real capture after Worker SIGKILL without capturing the source again", async () => {
    const f = await fixture();
    try {
      const original = await f.workspace(f.source, "mb-kill");
      await f.files(
        f.source,
        original,
        new Map([[".env", Buffer.from("DUMMY_CAPTURE=before-worker-loss\n")]]),
      );
      const captureId = randomUUID(),
        originalScope = await f.scope(f.source);
      const command: CantripOsBackupWorkerCommand = {
        type: "cantrip-os.backup.capture",
        operationId: captureId,
        scope: originalScope,
        transport: f.source,
        workspace: original,
        sources: [],
        protectedRequest: await f.request(captureId, {
          action: "capture",
          workspaceId: original.id,
          label: "Recover original bytes",
          exclusions: [],
        }),
      };
      await f.killAt(command, "capture");
      await f.files(
        f.source,
        original,
        new Map([
          [".env", Buffer.from("DUMMY_CAPTURE=changed-after-capture\n")],
        ]),
      );
      const recovered = await f.manager().handle({
        type: "cantrip-os.backup.observe",
        action: "capture",
        operationId: captureId,
        scope: originalScope,
        mode: "observe",
      });
      expect(recovered.state).toBe("ready");
      expect(
        f.calls.some(
          (args) =>
            args.includes("capture") ||
            args.includes("receive") ||
            args.includes("restore") ||
            args.includes("recover") ||
            args.includes("forget"),
        ),
      ).toBe(false);
      const destination = await f.workspace(f.target, "mb-recovered");
      const restoreId = randomUUID();
      expect(
        (
          await f.manager().handle({
            type: "cantrip-os.backup.restore",
            operationId: restoreId,
            scope: await f.scope(f.target),
            transport: f.target,
            workspace: destination,
            backupId: captureId,
            backupScope: originalScope,
            replace: false,
            protectedRequest: await f.request(restoreId, {
              action: "restore",
              workspaceId: destination.id,
              backupId: captureId,
              replace: false,
            }),
          })
        ).state,
      ).toBe("ready");
      expect(await f.files(f.target, destination)).toEqual(
        Buffer.from("DUMMY_CAPTURE=before-worker-loss\n"),
      );
    } finally {
      await f.close();
    }
  }, 180000);

  it("observes a completed activation after Worker SIGKILL without exchanging homes again", async () => {
    const f = await fixture();
    try {
      const original = await f.workspace(f.source, "mb-activation");
      await f.files(
        f.source,
        original,
        new Map([[".env", Buffer.from("DUMMY_RESTORE=backup\n")]]),
      );
      const captureId = randomUUID(),
        originalScope = await f.scope(f.source);
      expect(
        (
          await f.manager().handle({
            type: "cantrip-os.backup.capture",
            operationId: captureId,
            scope: originalScope,
            transport: f.source,
            workspace: original,
            sources: [],
            protectedRequest: await f.request(captureId, {
              action: "capture",
              workspaceId: original.id,
              label: "Activation recovery",
              exclusions: [],
            }),
          })
        ).state,
      ).toBe("ready");
      const destination = await f.workspace(f.target, "mb-activated");
      await f.files(
        f.target,
        destination,
        new Map([[".env", Buffer.from("DUMMY_RESTORE=original\n")]]),
      );
      const restoreId = randomUUID(),
        targetScope = await f.scope(f.target);
      await f.killAt(
        {
          type: "cantrip-os.backup.restore",
          operationId: restoreId,
          scope: targetScope,
          transport: f.target,
          workspace: destination,
          backupId: captureId,
          backupScope: originalScope,
          replace: true,
          protectedRequest: await f.request(restoreId, {
            action: "restore",
            workspaceId: destination.id,
            backupId: captureId,
            replace: true,
          }),
        },
        "restore",
      );
      f.calls.splice(0);
      const observed = await f.manager().handle({
        type: "cantrip-os.backup.observe",
        action: "restore",
        operationId: restoreId,
        scope: targetScope,
        mode: "observe",
      });
      expect(observed.state).toBe("ready");
      expect(
        f.calls.some(
          (args) =>
            args.includes("capture") ||
            args.includes("receive") ||
            args.includes("restore") ||
            args.includes("rollback") ||
            args.includes("recover") ||
            args.includes("forget"),
        ),
      ).toBe(false);
      expect(await f.files(f.target, destination)).toEqual(
        Buffer.from("DUMMY_RESTORE=backup\n"),
      );
      const rollbackId = randomUUID();
      expect(
        (
          await f.manager().handle({
            type: "cantrip-os.backup.rollback",
            operationId: rollbackId,
            scope: await f.scope(f.target),
            transport: f.target,
            workspace: destination,
            restoreOperationId: restoreId,
            protectedRequest: await f.request(rollbackId, {
              action: "rollback",
              workspaceId: destination.id,
              restoreOperationId: restoreId,
            }),
          })
        ).state,
      ).toBe("ready");
      expect(await f.files(f.target, destination)).toEqual(
        Buffer.from("DUMMY_RESTORE=original\n"),
      );
    } finally {
      await f.close();
    }
  }, 180000);

  it("recovers a published encrypted file after Worker loss while the source OS is stopped", async () => {
    const f = await fixture();
    let stopped = false;
    try {
      const original = await f.workspace(f.source, "mb-published");
      await f.files(
        f.source,
        original,
        new Map([[".env", Buffer.from("DUMMY_PUBLISHED=retained\n")]]),
      );
      const captureId = randomUUID(),
        originalScope = await f.scope(f.source);
      await f.killAt(
        {
          type: "cantrip-os.backup.capture",
          operationId: captureId,
          scope: originalScope,
          transport: f.source,
          workspace: original,
          sources: [],
          protectedRequest: await f.request(captureId, {
            action: "capture",
            workspaceId: original.id,
            label: "Published before acknowledgement",
            exclusions: [],
          }),
        },
        "forget",
      );
      if (f.source.kind === "docker") {
        await execute("docker", ["stop", f.source.container]);
        stopped = true;
      }
      const observed = await f.manager().handle({
        type: "cantrip-os.backup.observe",
        operationId: captureId,
        scope: originalScope,
        action: "capture",
        mode: "observe",
      });
      expect(observed.state).toBe("ready");
      expect(f.calls).toHaveLength(0);
      const result = await f.openResult(captureId, observed);
      expect(result.action).toBe("capture");
      if (result.action === "capture")
        expect(result.metadata.manifest).toMatchObject({
          cantrip: { label: "Published before acknowledgement" },
        });
    } finally {
      if (stopped && f.source.kind === "docker")
        await execute("docker", ["start", f.source.container]);
      await f.close();
    }
  }, 180000);
});
