#!/usr/bin/env node
import { readdir, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rebuild, root, container, inspect, run } from "./os.mjs";
import { withInstanceLock } from "./lock.mjs";
import { setTimeout as delay } from "node:timers/promises";

const inputs = [
  "manifests",
  "overlays",
  "images",
  "scripts",
  "viewer",
  "packages",
  ".dockerignore",
];
const excluded = new Set([
  ".git",
  ".build",
  ".state",
  "artifacts",
  "node_modules",
  ".cache",
  "logs",
]);

async function fingerprint() {
  const hash = createHash("sha256");
  async function visit(relative) {
    const path = join(root, relative);
    const { lstat } = await import("node:fs/promises");
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    hash.update(relative + "\0");
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (!excluded.has(entry) && !entry.endsWith(".log"))
          await visit(join(relative, entry));
      }
    } else hash.update(await readFile(path));
  }
  for (const path of inputs) await visit(path);
  return hash.digest("hex");
}

const foreground = process.argv.includes("--foreground");
const controller = new AbortController();
let stopped = false;
let finish;
const finished = new Promise((resolve) => {
  finish = resolve;
});
function stop() {
  if (stopped) return;
  stopped = true;
  controller.abort();
  finish();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function followLogs() {
  while (!stopped) {
    try {
      const current = await inspect();
      if (current?.State.Running) {
        // Attach to the ID so a replacement ends this stream. The next loop
        // follows the new container, including its early startup output.
        await run("docker", ["logs", "--follow", "--tail", "40", current.Id], {
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (!stopped) console.error(`[CantripOS] Log stream: ${error.message}`);
    }
    try {
      await delay(1000, undefined, { signal: controller.signal });
    } catch {
      break;
    }
  }
}

async function watch() {
  let signature = await fingerprint();
  let pending = true,
    running,
    debounce,
    poll;
  const logs = foreground ? followLogs() : Promise.resolve();
  function pump() {
    if (running || stopped || !pending) return;
    pending = false;
    console.log("[CantripOS] Building source changes…");
    running = (async () => {
      try {
        await rebuild({ signal: controller.signal });
        console.log("[CantripOS] Desktop updated. Watching for changes…");
      } catch (error) {
        if (!stopped)
          console.error(
            `[CantripOS] Rebuild failed; previous container retained if build failed. ${error.message}`,
          );
      } finally {
        running = undefined;
        if (pending && !stopped) debounce = setTimeout(pump, 600);
      }
    })();
  }
  async function scan() {
    try {
      const next = await fingerprint();
      if (next !== signature) {
        signature = next;
        pending = true;
        clearTimeout(debounce);
        if (!stopped) debounce = setTimeout(pump, 600);
      }
    } catch (error) {
      if (!stopped) console.error(`[CantripOS] Watch error: ${error.message}`);
    }
    if (!stopped) poll = setTimeout(scan, 400);
  }
  try {
    void scan();
    pump();
    await finished;
  } finally {
    clearTimeout(debounce);
    clearTimeout(poll);
    // Cancellation waits for the Docker CLI to exit before cleanup takes the
    // lifecycle lock, so an in-flight build cannot start a desktop afterward.
    await running;
    await logs;
  }
}

async function main() {
  if (!foreground) {
    await watch();
    console.log("[CantripOS] Watcher stopped; the desktop stays running.");
    return;
  }
  await withInstanceLock(
    `${container}-foreground`,
    async () => {
      console.log(
        "[CantripOS] Ctrl+C stops the desktop; your home volume is kept.",
      );
      try {
        await watch();
      } finally {
        console.log("[CantripOS] Stopping the desktop…");
        await withInstanceLock(container, async () => {
          const current = await inspect();
          if (current?.State.Running)
            await run("docker", ["stop", "--time", "10", current.Id]);
        });
        console.log("[CantripOS] Desktop stopped. Home volume retained.");
      }
    },
    { signal: controller.signal, wait: false },
  );
}
main().catch((error) => {
  if (error.name !== "AbortError") {
    console.error(`[CantripOS] ${error.message}`);
    process.exitCode = 1;
  }
});
