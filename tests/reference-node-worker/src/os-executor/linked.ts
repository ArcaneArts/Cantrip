import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LocalDocker,
  dependencyVolumes,
  finalizeRecreation,
  recreateWithSources,
  sourceMounts,
  withInstanceLock,
  type LinkedSourceMount,
} from "@cantrip/os-host";
import {
  OsExecutorDeliveryError,
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
} from "./connection.js";
import { guestFileUri } from "./paths.js";

interface DockerRecord {
  Id: string;
  Image: string;
  Config: { Labels?: Record<string, string> };
}
interface ExecutorStatus {
  service: string;
  instance_id: string;
  generation: string;
  attachment: { owner_id: string; worker_id: string } | null;
  workspaces: Record<string, { status: string }>;
}

async function initializeCache(
  engine: LocalDocker,
  image: string,
  name: string,
  uid: number,
  operationId: string,
  signal?: AbortSignal,
) {
  const helper = await engine.request<{ Id: string }>(
    "POST",
    "/containers/create",
    {
      Image: image,
      User: "0",
      Entrypoint: ["/bin/chown"],
      Cmd: [`${uid}:${uid}`, "/cache"],
      Labels: { "io.cantrip.os.cache-init": operationId },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Mounts: [
          {
            Type: "volume",
            Source: name,
            Target: "/cache",
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
    },
    { signal },
  );
  await engine.request("POST", `/containers/${helper.Id}/start`, undefined, {
    signal,
  });
  const result = await engine.request<{ StatusCode: number }>(
    "POST",
    `/containers/${helper.Id}/wait?condition=not-running`,
    undefined,
    { signal },
  );
  if (result.StatusCode !== 0)
    throw new Error("Linux dependency volume ownership initialization failed.");
  // Only the helper's dedicated named volume is chowned, never a host checkout.
  await engine.request("DELETE", `/containers/${helper.Id}?v=true`, undefined, {
    signal,
  });
}

function assertScope(actual: OsExecutorBinding, expected: OsExecutorBinding) {
  for (const key of [
    "instance_id",
    "owner_id",
    "worker_id",
    "workspace_id",
    "uid",
    "home",
  ] as const)
    if (actual[key] !== expected[key])
      throw new Error(
        "OS workspace identity changed; the previous placement was preserved.",
      );
}

/** Resolved host roots come from canonical worktree routing on the worker. A
 * browser-supplied directory is never substituted for this selected worktree. */
export async function installLinkedSource(input: {
  container: string;
  expected: OsExecutorBinding;
  mount: LinkedSourceMount;
  operationId: string;
  journalPath: string;
  signal?: AbortSignal;
}) {
  return withInstanceLock(
    input.container,
    async () => {
      const transport = { kind: "docker" as const, container: input.container };
      const status = await executorControl<ExecutorStatus>(transport, [
        "status",
      ]);
      if (
        status.service !== "running" ||
        status.instance_id !== input.expected.instance_id ||
        status.generation !== input.expected.generation ||
        status.attachment?.owner_id !== input.expected.owner_id ||
        status.attachment?.worker_id !== input.expected.worker_id
      )
        throw new Error(
          "OS attachment/runtime changed before source mounting.",
        );
      const hostRoot = await realpath(input.mount.workerPath);
      if (
        hostRoot === path.parse(hostRoot).root ||
        hostRoot === (await realpath(homedir()))
      )
        throw new Error(
          "A linked source must be an explicitly selected project/worktree directory, not the host root or home.",
        );
      if (!(await stat(hostRoot)).isDirectory())
        throw new Error("The selected worktree root is not a directory.");
      const mount = { ...input.mount, workerPath: hostRoot };
      const engine = await LocalDocker.current();
      const original = await engine.inspect<DockerRecord>(input.container);
      const current = sourceMounts(original, input.expected.instance_id);
      const old = current.find((binding) => binding.id === mount.id);
      if (old && !isDeepStrictEqual(old, mount))
        throw new Error(
          "This binding already has a different mount configuration; use a new binding generation.",
        );
      const bindings = old ? current : [...current, mount];
      const probeName = `.cantrip-os-link-${randomUUID()}`;
      const probePath = path.join(hostRoot, probeName);
      const fromHost = randomUUID(),
        fromGuest = randomUUID();
      const operationPath = `${input.journalPath}.binding`;
      const cleanupWarnings: string[] = [];
      const outcome: Record<string, unknown> = {
        version: 1,
        operationId: input.operationId,
        bindingId: mount.id,
        instanceId: input.expected.instance_id,
        ownerId: input.expected.owner_id,
        workerId: input.expected.worker_id,
        probePath,
        state: "planned",
        cleanupWarnings,
      };
      await mkdir(path.dirname(operationPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(operationPath, JSON.stringify(outcome) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let connection: OsExecutorConnection | undefined;
      let replacement:
        Awaited<ReturnType<typeof recreateWithSources>> | undefined;
      try {
        handle = await open(probePath, "wx", 0o600);
        // This disposable file contains only a random nonce. Its deliberately
        // shared mode verifies the mount itself without mistaking a host-only
        // 0600 probe for inaccessible source files on native Linux Docker.
        await handle.chmod(0o666);
        await handle.writeFile(fromHost);
        await handle.close();
        if (!old) {
          for (const volume of dependencyVolumes(input.expected.instance_id, [
            mount,
          ]))
            await initializeCache(
              engine,
              original.Image,
              volume.name,
              input.expected.uid,
              input.operationId,
              input.signal,
            );
          replacement = await recreateWithSources(engine, {
            container: input.container,
            expectedContainerId: original.Id,
            instanceId: input.expected.instance_id,
            bindings,
            operationId: input.operationId,
            journalPath: input.journalPath,
            signal: input.signal,
          });
        }
        // Service startup is observed, not retried as a mutation. Re-opening the
        // workspace below is one explicit executor admission after it is ready.
        let observed: ExecutorStatus | undefined;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          input.signal?.throwIfAborted();
          try {
            const sample = await executorControl<ExecutorStatus>(transport, [
              "status",
            ]);
            if (sample.service === "running") {
              observed = sample;
              break;
            }
          } catch {
            /* Read-only readiness observation; never replays mounting. */
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (
          !observed ||
          observed.instance_id !== input.expected.instance_id ||
          observed.attachment?.owner_id !== input.expected.owner_id ||
          observed.attachment?.worker_id !== input.expected.worker_id
        )
          throw new Error(
            "The replacement executor did not return the expected instance/attachment.",
          );
        const actual = await executorControl<OsExecutorBinding>(transport, [
          "open",
          input.expected.workspace_id,
        ]);
        assertScope(actual, input.expected);
        connection = new OsExecutorConnection(transport, actual);
        await connection.request("initialize", {
          clientName: "cantrip-linked-source",
          resumeSessionId: null,
        });
        connection.notify("initialized");
        const guestProbe = guestFileUri(`${mount.guestPath}/${probeName}`);
        const read = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          { path: guestProbe, sandbox: null },
        );
        if (Buffer.from(read.dataBase64, "base64").toString() !== fromHost)
          throw new Error(
            "The mounted worktree did not return the actual host file bytes.",
          );
        await connection.request("fs/writeFile", {
          path: guestProbe,
          dataBase64: Buffer.from(fromGuest).toString("base64"),
          sandbox: null,
        });
        if ((await readFile(probePath, "utf8")) !== fromGuest)
          throw new Error(
            "Guest edits did not reach the original host worktree.",
          );
        for (const overlay of mount.dependencyOverlays) {
          const file = `${mount.guestPath}/${overlay.path}/${probeName}`;
          await connection.request("fs/writeFile", {
            path: guestFileUri(file),
            dataBase64: Buffer.from(fromGuest).toString("base64"),
            sandbox: null,
          });
          try {
            await stat(path.join(hostRoot, overlay.path, probeName));
            throw new Error(
              "Linux dependency writes reached host dependencies.",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          } finally {
            await connection.request("fs/remove", {
              path: guestFileUri(file),
              recursive: false,
              force: false,
              sandbox: null,
            });
          }
        }
        if (replacement) {
          try {
            await finalizeRecreation(engine, replacement.journalPath, {
              signal: input.signal,
            });
          } catch {
            cleanupWarnings.push(
              "The previous container was retained because cleanup did not finish.",
            );
          }
        }
        const receipt = {
          bindingId: mount.id,
          guestPath: mount.guestPath,
          runtimeGeneration: actual.generation,
          workspaceId: actual.workspace_id,
          uid: actual.uid,
          homeGuestPath: actual.home,
          interruptedWorkspaces: replacement
            ? Object.keys(status.workspaces).filter(
                (name) => status.workspaces[name]?.status === "running",
              )
            : [],
          dependencyOverlays: mount.dependencyOverlays,
          recreated: replacement !== undefined,
          cleanupWarnings,
        };
        outcome.state = "succeeded";
        outcome.receipt = receipt;
        return receipt;
      } catch (error) {
        outcome.state =
          error &&
          typeof error === "object" &&
          Reflect.get(error, "delivery") === "unknown"
            ? "unknown"
            : "failed";
        outcome.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        try {
          await connection?.close();
        } catch {
          cleanupWarnings.push(
            "The verification carrier did not close cleanly.",
          );
        }
        try {
          await handle?.close();
        } catch {
          cleanupWarnings.push(
            "The host verification file handle did not close cleanly.",
          );
        }
        try {
          await unlink(probePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            cleanupWarnings.push(
              "The temporary host verification file could not be removed.",
            );
        }
        try {
          const temporary = `${operationPath}.${randomUUID()}`;
          await writeFile(temporary, JSON.stringify(outcome) + "\n", {
            mode: 0o600,
          });
          await rename(temporary, operationPath);
        } catch (error) {
          if (outcome.state === "succeeded") {
            const unknown = new OsExecutorDeliveryError(
              "The source was verified but its outcome journal could not be saved; inspect placement before retrying.",
            );
            unknown.cause = error;
            throw unknown;
          }
        }
      }
    },
    { signal: input.signal },
  );
}
