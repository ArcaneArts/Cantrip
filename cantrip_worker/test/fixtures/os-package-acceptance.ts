import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import {
  LocalDocker,
  PackageCarrierError,
  packageControl,
  registerBuiltPackage,
  rootGuestCommand,
} from "@cantrip/os-host";
import { decryptCantripOsPackageResult } from "@cantrip/crypto";
import {
  cantripOsPackageArtifactSchema,
  cantripOsPackageCatalogResultSchema,
  cantripOsPackageProbeSchema,
  cantripOsPackageOperationResultSchema,
  type CantripOsPackageArtifact,
  type CantripOsPackageOperationCommand,
} from "@cantrip/protocol";
import {
  CantripOsPackageManager,
  type PackagePorts,
} from "../../src/os-executor/package-manager.js";
import {
  packageCryptoContext,
  packageArguments,
  packageGuest,
} from "../../src/os-executor/package-context.js";
import { type OsExecutorTransport } from "../../src/os-executor/connection.js";

const execute = promisify(execFile);
export async function waitFor<T>(
  action: () => Promise<T>,
  accepted: (value: T) => boolean,
  label: string,
) {
  const deadline = Date.now() + 90_000;
  let last: unknown;
  do {
    try {
      const value = await action();
      if (accepted(value)) return value;
      last = value;
    } catch (error) {
      if (
        !(error instanceof PackageCarrierError) &&
        (error as { code?: number }).code !== 255
      )
        throw error;
      last = error instanceof Error ? error.message : error;
    }
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
export async function packageAcceptance() {
  const transport: OsExecutorTransport = JSON.parse(
    await readFile(process.env.CANTRIP_OS_TEST_PACKAGE_TRANSPORT!, "utf8"),
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-package-worker-"),
  );
  const catalog = path.join(directory, "catalog");
  await mkdir(catalog, { mode: 0o700 });
  const file = process.env.CANTRIP_OS_TEST_PACKAGE_DEB!;
  const manifest = await registerBuiltPackage(
    file,
    { name: "cantrip-os-recovery", version: "0.5.0", architecture: "all" },
    { directory: catalog },
  );
  const good = cantripOsPackageArtifactSchema.parse(manifest.artifact);
  const probe = cantripOsPackageProbeSchema.parse(
    await packageControl(transport, ["probe"]),
  );
  const scope = {
    ownerId: probe.expected.ownerId,
    workerId: probe.expected.workerId,
    serverId: "https://package-worker.acceptance.invalid",
    instanceId: randomUUID(),
    guestInstanceId: probe.expected.guestInstanceId,
    attachmentGeneration: randomUUID(),
  };
  const key = new Uint8Array(randomBytes(32));
  const keys = {
    ownerId: () => scope.ownerId,
    serverIdentity: () => scope.serverId,
    componentKey: () => ({ keyRevision: 1, key: new Uint8Array(key) }),
  };
  const root = `/tmp/cantrip-package-worker-${randomUUID()}`;
  const fixture = await readFile(
    new URL(
      "../../../cantrip_os/tests/package-repair-fixture.py",
      import.meta.url,
    ),
    "utf8",
  );
  const effects: string[] = [];
  const dispatchLog = path.join(directory, "dispatch.jsonl");
  const ports: PackagePorts = {
    docker: () => LocalDocker.current(),
    control: async (carrier, args, options) => {
      const action = args[args[0] === "--expect" ? 2 : 0]!;
      if (["admit", "receive", "start", "abandon"].includes(action)) {
        effects.push(action);
        const offset = args[0] === "--expect" ? 2 : 0;
        const operationId =
          action === "admit"
            ? JSON.parse(args[offset + 1]!).operationId
            : args[offset + 1];
        await appendFile(
          dispatchLog,
          JSON.stringify({
            action,
            operationId,
            at: Date.now(),
            pid: process.pid,
          }) + "\n",
          { mode: 0o600 },
        );
      }
      return packageControl(carrier, args, options);
    },
  };
  const manager = (storage = path.join(directory, "worker")) =>
    new CantripOsPackageManager(storage, scope.workerId, keys, catalog, ports);
  let current = manager();
  const inventory = cantripOsPackageCatalogResultSchema.parse(
    await current.handle({
      type: "cantrip-os.packages.status",
      scope,
      transport,
    }),
  );
  expect(inventory.available).toContainEqual(good);
  const command = (
    artifact = good,
    action: "upgrade" | "repair" = "upgrade",
    configuration: "preserve" | "package-defaults" = "preserve",
  ): CantripOsPackageOperationCommand => ({
    type: "cantrip-os.packages.operation",
    mode: "execute",
    operationId: randomUUID(),
    scope,
    transport,
    target: inventory.target,
    action,
    configuration,
    packages: [artifact],
  });
  const result = async (
    request: CantripOsPackageOperationCommand,
    mode = request.mode,
    selected = current,
  ) =>
    cantripOsPackageOperationResultSchema.parse(
      await selected.handle({ ...request, mode }),
    );
  const finish = (
    request: CantripOsPackageOperationCommand,
    selected = current,
  ) =>
    waitFor(
      () => result(request, "observe", selected),
      (value) => value.state === "ready" || value.state === "failed",
      "original package job has no committed result",
    );
  const privateResult = (
    request: CantripOsPackageOperationCommand,
    value: Awaited<ReturnType<typeof result>>,
  ) =>
    decryptCantripOsPackageResult({
      context: packageCryptoContext(request),
      componentKey: key,
      keyRevision: 1,
      envelope: value.protectedResult!,
    });
  const admin = (action: string, ...args: string[]) => {
    const invoke = async () => {
      const command = rootGuestCommand(transport, "/usr/bin/python3", [
        "-c",
        fixture,
        action,
        root,
        ...args,
      ]);
      const reply = await execute(command.command, command.args, {
        maxBuffer: 2 * 1024 * 1024,
      });
      return JSON.parse(reply.stdout);
    };
    return ["inspect", "saved", "record-exists"].includes(action)
      ? waitFor(invoke, () => true, "fixture observation unavailable")
      : invoke();
  };
  const publish = async (kind: string) => {
    const built = await admin("build", kind);
    const artifact = cantripOsPackageArtifactSchema.parse(built.package);
    const archive = path.join(directory, `${kind}.deb`);
    await writeFile(archive, Buffer.from(built.archive, "base64"), {
      mode: 0o600,
    });
    await registerBuiltPackage(
      archive,
      {
        name: artifact.name,
        version: artifact.version,
        architecture: artifact.architecture,
      },
      { directory: catalog },
    );
    const found = cantripOsPackageCatalogResultSchema.parse(
      await current.handle({
        type: "cantrip-os.packages.status",
        scope,
        transport,
        target: inventory.target,
      }),
    );
    expect(found.target).toEqual(inventory.target);
    expect(found.available).toContainEqual(artifact);
    return artifact;
  };
  const child = async (
    request: CantripOsPackageOperationCommand,
    hold: "start" | "receive",
  ) => {
    const barrier = path.join(directory, `${request.operationId}.barrier.json`);
    const configPath = path.join(
      directory,
      `${request.operationId}.child.json`,
    );
    await writeFile(
      configPath,
      JSON.stringify({
        directory: path.join(directory, "worker"),
        catalog,
        command: request,
        hold,
        barrier,
        dispatchLog,
        key: Buffer.from(key).toString("base64"),
      }),
      { mode: 0o600 },
    );
    const process = spawn(
      globalThis.process.execPath,
      [
        fileURLToPath(new URL("./os-package-child.mjs", import.meta.url)),
        configPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let diagnostics = "";
    process.stdout.resume();
    process.stderr.setEncoding("utf8").on("data", (value) => {
      diagnostics = (diagnostics + value).slice(-16384);
    });
    const ended = new Promise((resolve, reject) => {
      process.once("error", reject);
      process.once("close", (code, signal) => resolve({ code, signal }));
    });
    void ended.catch(() => {});
    try {
      const observed = await waitFor(
        async () => {
          if (process.exitCode !== null || process.signalCode !== null)
            throw new Error(`Worker-manager process ended: ${diagnostics}`);
          try {
            return JSON.parse(await readFile(barrier, "utf8"));
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code === "ENOENT" ||
              error instanceof SyntaxError
            )
              return null;
            throw error;
          }
        },
        (value) => value !== null,
        "Worker-manager barrier unavailable",
      );
      expect(observed.pid).toBe(process.pid);
      expect(observed.result.request.operationId).toBe(request.operationId);
      return {
        process,
        observed,
        kill: async () => {
          process.kill("SIGKILL");
          return ended;
        },
      };
    } catch (error) {
      process.kill("SIGKILL");
      await ended;
      throw error;
    }
  };
  const reobserve = () => {
    current = manager();
    return current;
  };
  const guest = async (
    request: CantripOsPackageOperationCommand,
    action = "inspect",
  ) =>
    packageGuest(
      request,
      await packageControl(
        transport,
        packageArguments(request, action, request.operationId),
      ),
    );
  const dispatches = async () =>
    (await readFile(dispatchLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    directory,
    catalog,
    good,
    transport,
    scope,
    root,
    inventory,
    effects,
    manager,
    command,
    result,
    finish,
    privateResult,
    admin,
    publish,
    child,
    reobserve,
    guest,
    dispatches,
    writeEvidence: (value: unknown) =>
      writeFile(
        path.join(directory, "acceptance.json"),
        JSON.stringify(value, null, 2) + "\n",
        { mode: 0o600 },
      ),
    unchanged: (
      before: Record<string, unknown>,
      after: Record<string, unknown>,
    ) =>
      expect(
        isDeepStrictEqual(
          before,
          Object.fromEntries(
            Object.keys(before).map((key) => [key, after[key]]),
          ),
        ),
      ).toBe(true),
  };
}
