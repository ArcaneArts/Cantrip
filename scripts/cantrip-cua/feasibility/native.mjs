import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(root, "target", "occluded-window");
const identity = process.env.CANTRIP_CUA_PROBE_SIGNING_IDENTITY;
const log = [];

function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

async function variant(optimization) {
  run(
    "xcrun",
    [
      "swiftc",
      "-parse-as-library",
      optimization,
      path.join(root, "occluded-window.swift"),
      "-o",
      destination,
      "-framework",
      "AppKit",
      "-framework",
      "ScreenCaptureKit",
    ],
    60_000,
  );
  if (identity) {
    run("codesign", [
      "--force",
      "--sign",
      identity,
      "--identifier",
      "art.cantrip.cua.feasibility",
      "--timestamp=none",
      destination,
    ]);
    run("codesign", ["--verify", "--strict", destination]);
  }
  const signature = run("codesign", ["--display", "-r-", destination]);
  const requirement = `${signature.stdout}\n${signature.stderr}`
    .split("\n")
    .find((line) => line.startsWith("designated =>"));
  const digest = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
  const capture = run(destination, []);
  const checkpoint = capture.stdout
    .split("\n")
    .find((line) => line.startsWith("QA_EVT "));
  assert.ok(checkpoint, "capture must emit a result");
  assert.equal(JSON.parse(checkpoint.slice(7)).status, "pass");
  log.push(checkpoint);
  console.log(checkpoint);
  return { digest, requirement };
}

await mkdir(path.dirname(destination), { recursive: true });
try {
  const first = await variant("-Onone");
  const second = await variant("-O");
  assert.notEqual(
    first.digest,
    second.digest,
    "rebuild must change executable bytes",
  );
  if (identity) {
    assert.ok(first.requirement);
    assert.equal(
      first.requirement,
      second.requirement,
      "signed rebuild changed designated requirement",
    );
  }
  const event = `QA_EVT ${JSON.stringify({
    event: "signed-rebuild",
    status: identity ? "pass" : "warn",
    distinctBuilds: true,
    signedRequirementUnchanged: identity ? true : null,
    details:
      "Capture passed twice; parent-app TCC attribution and packaged update remain separate verification.",
  })}`;
  log.push(event);
  console.log(event);
} catch (error) {
  process.exitCode = 1;
  const event = `QA_EVT ${JSON.stringify({ event: "native-probe", status: "fail", details: error.message })}`;
  log.push(event);
  console.error(event);
} finally {
  await writeFile(
    path.join(root, "target", "native-probe.log"),
    `${log.join("\n")}\n`,
  );
}
