import assert from "node:assert/strict";
import test from "node:test";
import { readWorkerCommandTypes } from "./worker-command-inventory.mjs";

test("inventory includes imported and extended native command schemas", async () => {
  const commands = await readWorkerCommandTypes();
  for (const command of [
    "chat.account-defaults",
    "chat.settings.update",
    "chat.permissions.update",
    "chat.settings.read",
    "computer-use.effects.sync",
    "chat.native-control",
  ]) {
    assert.ok(commands.includes(command), `Missing ${command}`);
  }
  assert.equal(new Set(commands).size, commands.length);
  // Nested payload discriminators and response outcomes are not commands.
  for (const value of ["continue", "cancel", "queued", "applied", "rejected"])
    assert.ok(!commands.includes(value), `Invented command ${value}`);
});
