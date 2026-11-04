#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { withInstanceLock } from "./lock.mjs";
import { randomUUID } from "node:crypto";
import {
  LocalDocker,
  recreateWithSources,
  finalizeRecreation,
  sourceMountsLabel,
} from "../host/index.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const container = process.env.CANTRIP_OS_NAME ?? "cantrip-os";
export const image = `${container}:dev`;
export const volume = `${container}-home`;
export const workspaceVolume = `${container}-workspaces`;
export const executorVolume = `${container}-executor`;
export const port = process.env.CANTRIP_OS_PORT ?? "6080";
export const vncPort = process.env.CANTRIP_OS_VNC_PORT ?? "5900";
export const workspacePort = process.env.CANTRIP_OS_WORKSPACE_PORT ?? "6081";

export function run(command, args, { capture = false, ...options } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      ...options,
    });
    let output = "",
      error = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      error += chunk;
    });
    let failure;
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? accept(output.trim())
          : reject(
              Object.assign(
                new Error(
                  `${command} exited ${code}${error ? `: ${error.trim()}` : ""}`,
                ),
                { code },
              ),
            ),
    );
  });
}

export async function inspect() {
  try {
    const record = JSON.parse(
      await run("docker", ["inspect", container], { capture: true }),
    )[0];
    if (record.Config.Labels?.["io.cantrip.os"] !== "foundation") {
      throw new Error(
        `Container ${container} is not a CantripOS foundation instance.`,
      );
    }
    return record;
  } catch (error) {
    if (error.message.includes("No such object")) return null;
    throw error;
  }
}
export async function build(options = {}) {
  const executor = process.env.CANTRIP_OS_EXECUTOR ?? "0";
  let executorContext = resolve(root, ".build/empty-executor");
  await mkdir(executorContext, { recursive: true });
  if (executor === "1") {
    const { prepareExecutor } = await import("./executor-package.mjs");
    executorContext = await prepareExecutor(
      process.arch === "arm64" ? "arm64" : "amd64",
      options,
    );
  }
  await run(
    "docker",
    [
      "build",
      "--progress=plain",
      "--build-arg",
      `CANTRIP_OS_WORKSPACES=${process.env.CANTRIP_OS_WORKSPACES ?? "1"}`,
      "--build-arg",
      `CANTRIP_OS_EXECUTOR=${executor}`,
      "--build-context",
      `executor=${executorContext}`,
      "-t",
      image,
      "-f",
      resolve(root, "images/oci/Dockerfile"),
      root,
    ],
    options,
  );
}
export async function up(options = {}) {
  if (await inspect()) await run("docker", ["start", container], options);
  else
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "--hostname",
        container,
        "--label",
        "io.cantrip.os=foundation",
        "--shm-size=1g",
        ...(process.env.CANTRIP_OS_MEMORY
          ? [
              "--memory",
              process.env.CANTRIP_OS_MEMORY,
              "--memory-swap",
              process.env.CANTRIP_OS_MEMORY,
            ]
          : []),
        "-p",
        `127.0.0.1:${port}:6080`,
        "-p",
        `127.0.0.1:${vncPort}:5900`,
        ...(process.env.CANTRIP_OS_WORKSPACES === "0"
          ? []
          : ["-p", `127.0.0.1:${workspacePort}:6081`]),
        "-v",
        `${volume}:/home/cantrip`,
        "-v",
        `${workspaceVolume}:/var/lib/cantrip-os-workspaces`,
        "-v",
        `${executorVolume}:/var/lib/cantrip-os-executor`,
        image,
      ],
      options,
    );
  // Existing detached containers keep their original published ports.
  const ports = (await inspect())?.NetworkSettings.Ports ?? {};
  const browserPort = ports["6080/tcp"]?.[0]?.HostPort;
  const nativePort = ports["5900/tcp"]?.[0]?.HostPort;
  const desktopsPort = ports["6081/tcp"]?.[0]?.HostPort;
  console.log(`
CantripOS browser: ${browserPort ? `http://127.0.0.1:${browserPort}/` : "not published"}
Workspaces: ${desktopsPort ? `http://127.0.0.1:${desktopsPort}/ (optional package; enable it if disabled)` : "not published"}
VNC: ${nativePort ? `127.0.0.1:${nativePort} (no password; host loopback only)` : "not published"}
Shell: docker exec -it ${container} bash
SSH: not enabled in the foundation image.
`);
}
export async function rebuild({ signal } = {}) {
  await withInstanceLock(
    container,
    async () => {
      await build({ signal });
      signal?.throwIfAborted();
      const previous = await inspect();
      const savedMounts = previous?.Config.Labels?.[sourceMountsLabel];
      if (savedMounts) {
        const state = JSON.parse(savedMounts);
        const engine = await LocalDocker.current();
        const replacement = await recreateWithSources(engine, {
          container,
          expectedContainerId: previous.Id,
          instanceId: state.instanceId,
          bindings: state.bindings,
          operationId: randomUUID(),
          image,
          signal,
          journalPath: resolve(
            root,
            ".state",
            container,
            `rebuild-${randomUUID()}.json`,
          ),
        });
        await finalizeRecreation(engine, replacement.journalPath, { signal });
      } else if (previous)
        await run("docker", ["rm", "-f", container], { signal });
      signal?.throwIfAborted();
      await up({ signal });
    },
    { signal },
  );
}
async function main() {
  switch (process.argv[2]) {
    case "build":
      await withInstanceLock(container, build);
      break;
    case "up":
      await withInstanceLock(container, up);
      break;
    case "rebuild":
      await rebuild();
      break;
    case "restart":
      await withInstanceLock(container, async () => {
        await inspect();
        await run("docker", ["restart", container]);
      });
      break;
    case "stop":
      await withInstanceLock(container, async () => {
        await inspect();
        await run("docker", ["stop", container]);
      });
      break;
    case "logs":
      await run("docker", ["logs", "-f", container]);
      break;
    case "reset":
      await withInstanceLock(container, async () => {
        if (await inspect()) await run("docker", ["rm", "-f", container]);
        for (const name of [volume, workspaceVolume, executorVolume]) {
          try {
            await run("docker", ["volume", "rm", name], { capture: true });
          } catch (error) {
            // Older instances may not have an executor volume. Attempt the
            // deletion and accept Docker's actual missing-volume response.
            if (!error.message.includes("no such volume")) throw error;
          }
        }
      });
      break;
    default:
      throw new Error(
        "Usage: node cantrip_os/scripts/os.mjs build|up|rebuild|restart|stop|logs|reset",
      );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
