#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { withInstanceLock } from "./lock.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const container = process.env.CANTRIP_OS_NAME ?? "cantrip-os";
export const image = `${container}:dev`;
export const volume = `${container}-home`;
export const port = process.env.CANTRIP_OS_PORT ?? "6080";

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
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
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
export async function build() {
  await run("docker", [
    "build",
    "-t",
    image,
    "-f",
    resolve(root, "images/oci/Dockerfile"),
    root,
  ]);
}
export async function up() {
  if (await inspect()) await run("docker", ["start", container]);
  else
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--hostname",
      container,
      "--label",
      "io.cantrip.os=foundation",
      "--shm-size=1g",
      "-p",
      `127.0.0.1:${port}:6080`,
      "-v",
      `${volume}:/home/cantrip`,
      image,
    ]);
  console.log(`CantripOS: http://127.0.0.1:${port}`);
}
export async function rebuild() {
  await withInstanceLock(container, async () => {
    await build();
    if (await inspect()) await run("docker", ["rm", "-f", container]);
    await up();
  });
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
        await run("docker", ["volume", "rm", volume]);
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
