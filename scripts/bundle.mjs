import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertHostTarget,
  normalizeTarget,
} from "./cantrip-code/build-lib.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function execute(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? scriptRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${options.label ?? command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
  });
}

export async function bundleNativeArtifacts({
  root = scriptRoot,
  run = execute,
  target: targetInput = normalizeTarget(),
} = {}) {
  const target =
    typeof targetInput === "string"
      ? normalizeTarget(targetInput)
      : targetInput;
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const distributionScript = path.join(
    root,
    "scripts",
    "package-distributions.mjs",
  );
  const appScript = path.join(root, "scripts", "package-app.mjs");
  const archiveScript = path.join(root, "scripts", "archive-distribution.mjs");
  const output = path.join(root, "artifacts", "bundles", target.id);
  await rm(output, { force: true, recursive: true });

  await run(pnpm, ["--filter", "@cantrip/version", "build"], {
    cwd: root,
    label: "Version build",
  });
  await run(pnpm, ["--filter", "@cantrip/logging", "build"], {
    cwd: root,
    label: "Logging build",
  });
  await run(pnpm, ["--filter", "@cantrip/protocol", "build"], {
    cwd: root,
    label: "Protocol build",
  });
  await Promise.all(
    ["server", "worker"].map((service) =>
      run(
        process.execPath,
        [
          distributionScript,
          service,
          "--target",
          target.id,
          "--skip-protocol-build",
        ],
        { cwd: root, label: `${service} package` },
      ),
    ),
  );
  await run(
    process.execPath,
    [appScript, "--target", target.id, "--from-artifacts"],
    { cwd: root, label: "Desktop package" },
  );
  await Promise.all(
    ["server", "worker", "client"].map((kind) =>
      run(process.execPath, [archiveScript, kind, "--target", target.id], {
        cwd: root,
        label: `${kind} archive`,
      }),
    ),
  );
  return output;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = normalizeTarget();
  assertHostTarget(target);
  const output = await bundleNativeArtifacts({ target });
  console.log(
    `Native Cantrip bundles are ready: ${path.relative(scriptRoot, output)}`,
  );
}
