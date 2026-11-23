import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import {
  cantripOsBackupRequestEnvelopeSchema,
  type CantripOsBackupWorkerCommand,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import { CantripOsBackupManager } from "./backup-manager.js";
import { CantripOsController } from "./controller.js";
import { OsExecutorDeliveryError } from "./connection.js";
import {
  recoveryGuestRecordSchema,
  type RecoveryGuestRecord,
} from "./recovery-carrier.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-reset-worker-")),
    key = randomBytes(32);
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  const workspace = {
    id: randomUUID(),
    guestWorkspaceId: "example",
    uid: 20000,
    gid: 20000,
    homeGuestPath: "/private/example",
  };
  const operationId = randomUUID();
  const keys = {
    ownerId: () => scope.ownerId,
    serverIdentity: () => scope.serverId,
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  };
  const current = vi.fn(async () => {});
  const controllers: CantripOsController[] = [];
  const control =
    vi.fn<
      (
        ...args: Parameters<
          typeof import("./recovery-carrier.js").recoveryControl
        >
      ) => Promise<RecoveryGuestRecord>
    >();
  const manager = () => {
    const controller = new CantripOsController(directory, scope.workerId);
    controllers.push(controller);
    vi.spyOn(controller, "assertAdministrativeScope").mockImplementation(
      current,
    );
    return new CantripOsBackupManager(
      directory,
      scope.workerId,
      controller,
      keys,
      {
        control,
        exportArchive: async function* () {
          throw new Error("Reset must not export an archive");
        },
      },
    );
  };
  const command = async (
    intent: unknown = {
      action: "reset",
      workspaceId: workspace.id,
      paths: [".config/chromium"],
    },
  ): Promise<
    Extract<CantripOsBackupWorkerCommand, { type: "cantrip-os.backup.reset" }>
  > => ({
    type: "cantrip-os.backup.reset",
    scope,
    workspace,
    operationId,
    transport: { kind: "docker", container: "unused" },
    protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ...scope,
        operationId,
        componentKey: key,
        keyRevision: 1,
        direction: "request",
        plaintext: new TextEncoder().encode(JSON.stringify(intent)),
      }),
    ),
  });
  const receipt = {
    workspace: {
      id: workspace.guestWorkspaceId,
      uid: workspace.uid,
      gid: workspace.gid,
      home: workspace.homeGuestPath,
    },
    reset_paths: [".config/chromium"],
    retained_original_home: "/private/.cantrip-reset/home",
    shared_system_state_changed: false,
    runtime_handles_restored: false,
  };
  const guest: RecoveryGuestRecord = {
    version: 2,
    operation_id: operationId,
    action: "reset",
    state: "reset",
    receipt,
    error: null,
    active: false,
    maintenance: {
      released: true,
      interrupted_workspaces: ["example", "other"],
    },
  };
  const observe = (
    mode: "observe" | "recover" = "observe",
  ): CantripOsBackupWorkerCommand => ({
    type: "cantrip-os.backup.observe",
    scope,
    operationId,
    action: "reset",
    mode,
  });
  const open = async (
    result: Awaited<ReturnType<CantripOsBackupManager["handle"]>>,
  ) => {
    const bytes = await decryptCantripOsBackupMessage({
      ...scope,
      operationId,
      componentKey: key,
      keyRevision: 1,
      direction: "response",
      frame: result.protectedResult!,
    });
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      bytes.fill(0);
    }
  };
  cleanups.push(async () => {
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    scope,
    workspace,
    operationId,
    control,
    manager,
    current,
    command,
    guest,
    observe,
    open,
  };
}

it("returns a verified reset and interruption receipt only through account encryption", async () => {
  const f = await fixture();
  f.control.mockResolvedValue(f.guest);
  const command = await f.command(),
    result = await f.manager().handle(command);
  expect(result).toMatchObject({
    state: "ready",
    action: "reset",
    phase: "complete",
    error: null,
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
  expect(await f.open(result)).toMatchObject({
    action: "reset",
    receipt: f.guest.receipt,
    interruption: {
      released: true,
      interrupted_workspaces: ["example", "other"],
    },
  });
  const args = f.control.mock.calls[0]![0].args;
  expect(JSON.parse(args[args.indexOf("--expect-workspace") + 1]!)).toEqual({
    uid: 20000,
    gid: 20000,
    home: "/private/example",
  });
  expect(JSON.parse(args[args.indexOf("--expect") + 1]!)).toMatchObject({
    runtimeGeneration: f.scope.runtimeGeneration,
  });
  expect(f.current).toHaveBeenCalledOnce();
});

it("rejects invalid private selections before admission or guest effects", async () => {
  const f = await fixture();
  for (const paths of [
    [],
    ["../etc"],
    ["/etc"],
    ["a//b"],
    ["a/./b"],
    ["a/"],
    ["a\0b"],
    ["a", "a/b"],
    [".", "Documents"],
    ["a", "a"],
  ])
    await expect(
      f.manager().handle(
        await f.command({
          action: "reset",
          workspaceId: f.workspace.id,
          paths,
        }),
      ),
    ).rejects.toThrow();
  await expect(
    f.manager().handle(
      await f.command({
        action: "reset",
        workspaceId: randomUUID(),
        paths: ["."],
      }),
    ),
  ).rejects.toThrow("canonical admission");
  expect(f.control).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual([]);
});

it("recovers a lost reset reply from the same guest receipt after reopening without repeating effects", async () => {
  const f = await fixture();
  f.control
    .mockRejectedValueOnce(
      new OsExecutorDeliveryError("Reply lost after exchange"),
    )
    .mockResolvedValue(f.guest);
  const command = await f.command();
  expect((await f.manager().handle(command)).state).toBe("unknown");
  expect((await f.manager().handle(command)).state).toBe("unknown");
  expect(f.control).toHaveBeenCalledTimes(1);
  const recovered = await f.manager().handle(f.observe("recover"));
  expect(recovered.state).toBe("ready");
  expect((await f.open(recovered)).receipt).toEqual(f.guest.receipt);
  expect(
    f.control.mock.calls.map(([input]) =>
      input.args.filter((arg) => ["reset", "inspect", "recover"].includes(arg)),
    ),
  ).toEqual([["reset"], ["inspect"]]);
  expect(f.current).toHaveBeenCalledOnce();
});

it.each(["uid", "gid", "id", "home", "paths"])(
  "refuses mismatched %s completion without resetting again",
  async (field) => {
    const f = await fixture();
    const wrong = structuredClone(f.guest);
    if (field === "paths") wrong.receipt!.reset_paths = ["Documents"];
    else
      (wrong.receipt!.workspace as Record<string, unknown>)[field] =
        field === "uid" || field === "gid" ? 20001 : "different";
    f.control.mockResolvedValue(wrong);
    expect((await f.manager().handle(await f.command())).state).toBe("unknown");
    expect((await f.manager().handle(f.observe("recover"))).state).toBe(
      "unknown",
    );
    expect(
      f.control.mock.calls.filter(([input]) => input.args.includes("reset")),
    ).toHaveLength(1);
  },
);

it("observation does not release interrupted maintenance; explicit recovery reconciles its exact exchange", async () => {
  const f = await fixture();
  f.control.mockRejectedValueOnce(new OsExecutorDeliveryError("Worker ended"));
  await f.manager().handle(await f.command());
  const interrupted = {
    ...f.guest,
    state: "unknown" as const,
    receipt: null,
    maintenance: { released: false },
  };
  f.control.mockResolvedValueOnce(interrupted);
  expect((await f.manager().handle(f.observe())).state).toBe("unknown");
  expect(f.control.mock.calls.at(-1)![0].args).toContain("inspect");
  f.control.mockResolvedValueOnce(interrupted).mockResolvedValueOnce(f.guest);
  expect((await f.manager().handle(f.observe("recover"))).state).toBe("ready");
  expect(f.control.mock.calls.at(-1)![0].args).toContain("recover");
  expect(
    f.control.mock.calls.filter(([input]) => input.args.includes("reset")),
  ).toHaveLength(1);
});

it("preserves a conclusively failed guest result and encrypts its diagnostic", async () => {
  const f = await fixture();
  f.control.mockResolvedValue({
    ...f.guest,
    state: "failed",
    receipt: null,
    error: "Mount at /private/example is still attached",
  });
  const result = await f.manager().handle(await f.command());
  expect(result.state).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("/private/");
  expect(await f.open(result)).toMatchObject({
    action: "error",
    operationAction: "reset",
    message: "Mount at /private/example is still attached",
  });
});

it("accepts existing guest records and rejects unsupported action/version pairs", async () => {
  const f = await fixture();
  expect(recoveryGuestRecordSchema.parse(f.guest).version).toBe(2);
  expect(
    recoveryGuestRecordSchema.parse({
      ...f.guest,
      version: 1,
      action: "capture",
      state: "captured",
    }).version,
  ).toBe(1);
  for (const record of [
    { ...f.guest, version: 1 },
    { ...f.guest, version: 2, action: "capture" },
    { ...f.guest, version: 3 },
    { ...f.guest, state: "restored" },
  ])
    expect(recoveryGuestRecordSchema.safeParse(record).success).toBe(false);
});
