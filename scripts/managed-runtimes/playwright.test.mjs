import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyPortableHostFile,
  readPlaywrightLock,
  validatePlaywrightLock,
} from "./playwright-lib.mjs";

test("portable host files materialize symlink targets", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-host-file-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "loader-real");
  const source = path.join(directory, "loader-link");
  const destination = path.join(directory, "loader-copy");
  await writeFile(target, "portable loader");
  await symlink(target, source);
  await copyPortableHostFile(source, destination);
  await rm(target);
  assert.equal(await readFile(destination, "utf8"), "portable loader");
  assert.equal((await lstat(destination)).isSymbolicLink(), false);
});

test("Playwright lock pins one matching browser unit for all six targets", async () => {
  const lock = await readPlaywrightLock();
  assert.equal(Object.keys(lock.targets).length, 6);
  assert.equal(lock.playwright.version, "1.62.1");
  assert.equal(lock.chromium.revision, "1234");
  assert.throws(
    () =>
      validatePlaywrightLock({
        ...lock,
        playwright: { ...lock.playwright, version: "latest" },
      }),
    /exact/,
  );
});

test("Windows ARM64 explicitly records Chromium x64 emulation", async () => {
  const lock = await readPlaywrightLock();
  assert.equal(lock.targets["win32-arm64"].browserArchitecture, "x64-emulated");
});
