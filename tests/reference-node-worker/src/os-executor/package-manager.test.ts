import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PackageCarrierError } from "@cantrip/os-host";
import { decryptCantripOsPackageResult } from "@cantrip/crypto";
import {
  cantripOsPackageOperationResultSchema,
  type CantripOsGuestPackageRecord,
  type CantripOsPackageOperationCommand,
} from "@cantrip/protocol";
import {
  CantripOsPackageManager,
  type PackagePorts,
} from "./package-manager.js";
import { packageCryptoContext, packageRequest } from "./package-context.js";

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-package-manager-"),
  );
  const key = new Uint8Array(randomBytes(32));
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
  };
  const command: CantripOsPackageOperationCommand = {
    type: "cantrip-os.packages.operation",
    mode: "execute",
    operationId: randomUUID(),
    scope,
    transport: { kind: "docker", container: "package-unit-" + randomUUID() },
    target: {
      generation: randomUUID(),
      containerId: "c".repeat(64),
      expected: {
        guestInstanceId: scope.guestInstanceId,
        ownerId: scope.ownerId,
        workerId: scope.workerId,
        identityPath: "/private/guest/instance.json",
      },
      bootId: randomUUID(),
      initStart: "42",
      architecture: "arm64",
    },
    action: "repair",
    configuration: "preserve",
    packages: [
      {
        name: "cantrip-os-recovery",
        version: "0.5.0",
        architecture: "all",
        bytes: 4,
        sha256: createHash("sha256").update("DEB!").digest("hex"),
      },
    ],
  };
  const artifact = path.join(directory, "fixture.deb");
  await writeFile(artifact, "DEB!");
  let guest: CantripOsGuestPackageRecord | null = null;
  let loseStart = false;
  const effects: string[] = [];
  const keys = {
    ownerId: () => scope.ownerId,
    serverIdentity: () => scope.serverId,
    componentKey: vi.fn(() => ({ keyRevision: 1, key: new Uint8Array(key) })),
  };
  const ports: PackagePorts = {
    docker: async () => ({
      inspect: async <T>() => ({ Id: "c".repeat(64) }) as T,
    }),
    control: vi.fn(async (_transport, args, options) => {
      const action = args[0] === "--expect" ? args[2] : args[0];
      if (action === "admit") {
        effects.push(action!);
        guest = {
          format: "cantrip-os-package-operation",
          version: 1,
          request: packageRequest(command),
          requestSha256: "f".repeat(64),
          state: "staged",
          phase: "admitted",
          createdAt: 123,
          updatedAt: 123,
          received: [],
          process: null,
          installer: null,
          receipt: null,
          error: null,
          active: false,
          installerActive: false,
          diagnostics: "/private/guest/log",
        };
      } else if (!guest)
        throw new PackageCarrierError("Original guest record unavailable");
      if (action === "receive") {
        effects.push(action);
        if (options?.input)
          for await (const _block of options.input) {
            /* drain the actual file stream */
          }
        guest!.received = command.packages.map((p) => p.sha256);
        guest!.phase = "ready-to-install";
      }
      if (action === "start") {
        effects.push(action);
        guest!.state = "ready";
        guest!.phase = "complete";
        guest!.receipt = {
          exitCode: 0,
          configurationPolicy: command.configuration,
          runtimeHandlesRestored: false,
          packages: command.packages.map((p) => ({
            name: p.name,
            exitCode: 0,
            status: `install ok installed\t${p.version}\t${p.architecture}`,
          })),
          helpers: command.packages.map((p) => ({ name: p.name, exitCode: 0 })),
          retainedOriginals: "/private/originals",
        };
        if (loseStart) {
          loseStart = false;
          throw new PackageCarrierError("Actual start response was lost");
        }
      }
      if (action === "abandon") {
        effects.push(action);
        guest!.state = "failed";
        guest!.phase = "abandoned";
        guest!.error = "Explicitly abandoned";
      }
      return structuredClone(guest);
    }),
  };
  const manager = (where = directory) => {
    const instance = new CantripOsPackageManager(
      where,
      scope.workerId,
      keys,
      undefined,
      ports,
    );
    vi.spyOn(instance.catalog, "file").mockResolvedValue(artifact);
    return instance;
  };
  const result = async (
    instance: CantripOsPackageManager,
    mode = command.mode,
  ) =>
    cantripOsPackageOperationResultSchema.parse(
      await instance.handle({ ...command, mode }),
    );
  const decrypt = (value: Awaited<ReturnType<typeof result>>) =>
    decryptCantripOsPackageResult({
      context: packageCryptoContext(command),
      keyRevision: 1,
      componentKey: key,
      envelope: value.protectedResult!,
    });
  return {
    directory,
    command,
    keys,
    ports,
    effects,
    manager,
    result,
    decrypt,
    lose: () => {
      loseStart = true;
    },
    guest: () => guest!,
    setGuest: (value: CantripOsGuestPackageRecord) => {
      guest = value;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
describe("durable Worker package admissions", () => {
  it("recovers a lost start reply from the original guest without another upload or installer", async () => {
    const f = await fixture();
    try {
      f.lose();
      const unknown = await f.result(f.manager());
      expect(unknown.state).toBe("unknown");
      expect(JSON.stringify(unknown)).not.toContain("/private/");
      expect((await f.decrypt(unknown)).diagnostic).toContain(
        "start response was lost",
      );
      const recovered = await f.result(f.manager(), "observe");
      expect(recovered.state).toBe("ready");
      expect(recovered.startedAt).toBe(unknown.startedAt);
      expect((await f.decrypt(recovered)).record?.request).toEqual(
        packageRequest(f.command),
      );
      expect((await f.result(f.manager())).protectedResult).toEqual(
        recovered.protectedResult,
      );
      expect(f.effects).toEqual(["admit", "receive", "start"]);
      await expect(
        f.manager().handle({ ...f.command, configuration: "package-defaults" }),
      ).rejects.toThrow("different admission");
    } finally {
      await f.close();
    }
  });
  it("a missing Worker journal recovers only from a matching guest record and never needs an artifact cache", async () => {
    const f = await fixture();
    try {
      await f.result(f.manager());
      const before = [...f.effects];
      const fresh = f.manager(path.join(f.directory, "replacement"));
      vi.mocked(fresh.catalog.file).mockRejectedValue(
        new Error("No artifact cache"),
      );
      expect((await f.result(fresh, "observe")).state).toBe("ready");
      expect(f.effects).toEqual(before);
      f.setGuest({
        ...f.guest(),
        request: { ...f.guest().request, configuration: "package-defaults" },
      });
      const wrong = await f.result(
        f.manager(path.join(f.directory, "wrong")),
        "observe",
      );
      expect(wrong.state).toBe("unknown");
      expect((await f.decrypt(wrong)).diagnostic).toContain(
        "different original admission",
      );
      expect(f.effects).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it("observation of absent work never creates it; explicit continuation and abandonment use the original staging", async () => {
    const f = await fixture();
    try {
      const manager = f.manager();
      expect((await f.result(manager, "observe")).state).toBe("unknown");
      expect(f.effects).toEqual([]);
      const guest: CantripOsGuestPackageRecord = {
        format: "cantrip-os-package-operation",
        version: 1,
        request: packageRequest(f.command),
        requestSha256: "d".repeat(64),
        state: "staged",
        phase: "admitted",
        createdAt: 1,
        updatedAt: 1,
        received: [],
        process: null,
        installer: null,
        active: false,
        installerActive: false,
        receipt: null,
        error: null,
        diagnostics: "",
      };
      f.setGuest(guest);
      expect((await f.result(manager, "observe")).state).toBe("unknown");
      expect(f.effects).toEqual([]);
      expect((await f.result(manager, "continue")).state).toBe("ready");
      expect(f.effects).toEqual(["receive", "start"]);
      const other = await fixture();
      try {
        other.setGuest({
          ...guest,
          request: packageRequest(other.command),
          state: "staged",
          phase: "admitted",
          received: [],
          receipt: null,
        });
        const discarded = await other.result(other.manager(), "abandon");
        expect(discarded).toMatchObject({
          state: "failed",
          phase: "abandoned",
        });
        expect((await other.result(other.manager())).state).toBe("failed");
        expect(other.effects).toEqual(["abandon"]);
      } finally {
        await other.close();
      }
    } finally {
      await f.close();
    }
  });
  it("key loss retains a completed private receipt and changed ownership is rejected before guest access", async () => {
    const f = await fixture();
    try {
      f.keys.componentKey.mockImplementationOnce(() => {
        throw new Error("Key temporarily unavailable");
      });
      await expect(f.result(f.manager())).rejects.toThrow(
        "Key temporarily unavailable",
      );
      const before = [...f.effects];
      expect((await f.result(f.manager(), "observe")).state).toBe("ready");
      expect(f.effects).toEqual(before);
      await expect(
        f.manager().handle({
          ...f.command,
          scope: { ...f.command.scope, workerId: "another" },
        }),
      ).rejects.toThrow("another Worker");
      await expect(
        f.manager().handle({
          ...f.command,
          target: {
            ...f.command.target,
            expected: { ...f.command.target.expected, ownerId: "another" },
          },
        }),
      ).rejects.toThrow("owning admission");
      expect(f.effects).toEqual(before);
    } finally {
      await f.close();
    }
  });
});
