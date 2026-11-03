#!/usr/bin/env node
import { readdir, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rebuild, root } from "./os.mjs";

const inputs = [
  "manifests",
  "overlays",
  "images",
  "scripts",
  "viewer",
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

let signature = await fingerprint();
let pending = true,
  running = false,
  stopped = false,
  debounce,
  poll;
async function pump() {
  if (running || stopped || !pending) return;
  running = true;
  pending = false;
  console.log("[CantripOS] Building source changes…");
  try {
    await rebuild();
    console.log("[CantripOS] Desktop updated. Watching for changes…");
  } catch (error) {
    console.error(
      `[CantripOS] Rebuild failed; previous container retained if build failed. ${error.message}`,
    );
  } finally {
    running = false;
    if (pending && !stopped) debounce = setTimeout(pump, 600);
  }
}
async function scan() {
  try {
    const next = await fingerprint();
    if (next !== signature) {
      signature = next;
      pending = true;
      clearTimeout(debounce);
      debounce = setTimeout(pump, 600);
    }
  } catch (error) {
    console.error(`[CantripOS] Watch error: ${error.message}`);
  }
  if (!stopped) poll = setTimeout(scan, 400);
}
function stop() {
  stopped = true;
  clearTimeout(debounce);
  clearTimeout(poll);
  console.log("[CantripOS] Watcher stopped; the desktop stays running.");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
void scan();
void pump();
