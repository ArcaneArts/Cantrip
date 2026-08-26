import { readFile } from "node:fs/promises";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "../..");
export const inputRoot = path.join(root, "managed_runtimes", "playwright");

export async function readPlaywrightLock() {
  const lock = JSON.parse(
    await readFile(path.join(inputRoot, "runtime.lock.json"), "utf8"),
  );
  validatePlaywrightLock(lock);
  return lock;
}

export function validatePlaywrightLock(lock) {
  if (lock?.schemaVersion !== 1 || lock?.component !== "playwright")
    throw new Error("invalid Playwright runtime lock");
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(lock.bundleVersion ?? ""))
    throw new Error("invalid Playwright bundle version");
  if (!/^\d+\.\d+\.\d+$/.test(lock.playwright?.version ?? ""))
    throw new Error("Playwright version must be exact");
  if (
    !/^https:\/\//.test(lock.playwright?.packageUrl ?? "") ||
    !/^[a-f0-9]{64}$/.test(lock.playwright?.packageSha256 ?? "") ||
    lock.playwright?.packageBytes < 1
  )
    throw new Error(
      "Playwright package must be pinned by URL, bytes, and SHA-256",
    );
  if (!/^\d+$/.test(lock.chromium?.revision ?? ""))
    throw new Error("Chromium revision must be exact");
  const expected = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];
  if (
    JSON.stringify(Object.keys(lock.targets ?? {}).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error("all six Playwright runtime targets must be pinned");
  for (const [target, value] of Object.entries(lock.targets)) {
    if (`${value.platform}-${value.architecture}` !== target)
      throw new Error(`Playwright target metadata mismatch: ${target}`);
  }
}
