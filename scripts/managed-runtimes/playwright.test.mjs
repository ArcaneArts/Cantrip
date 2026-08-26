import assert from "node:assert/strict";
import test from "node:test";
import {
  readPlaywrightLock,
  validatePlaywrightLock,
} from "./playwright-lib.mjs";

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
