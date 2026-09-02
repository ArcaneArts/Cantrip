import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds the desktop glitch workspace in synthetic worktrees", async () => {
  const source = await readFile(
    new URL("./synthetic-build.mjs", import.meta.url),
    "utf8",
  );
  const serviceStepStart = source.indexOf(
    'await step("build-services", "Build Cantrip services"',
  );
  const desktopStepStart = source.indexOf(
    'await step("build-desktop", "Package Cantrip desktop"',
  );
  assert.notEqual(serviceStepStart, -1);
  assert.ok(desktopStepStart > serviceStepStart);

  const serviceStep = source.slice(serviceStepStart, desktopStepStart);
  const protocolBuild = serviceStep.indexOf('"@cantrip/protocol"');
  const glitchBuild = serviceStep.indexOf('"@cantrip/glitch"');
  assert.notEqual(protocolBuild, -1);
  assert.ok(
    glitchBuild > protocolBuild,
    "@cantrip/glitch must be built after its @cantrip/protocol dependency",
  );
});
