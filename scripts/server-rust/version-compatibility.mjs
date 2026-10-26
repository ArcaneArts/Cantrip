// Exercise the real build metadata and HTTP schema failure path in both
// runtimes, then restore normal artifacts even when the comparison fails.
import { spawn } from "node:child_process";
import { buildRustServer, repositoryRoot } from "./build.mjs";

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Version comparison command failed (${code ?? signal}).`),
          ),
    );
  });
}

const environment = {
  ...process.env,
  CANTRIP_SYNTHETIC_BUILD: "1",
  CANTRIP_SYNTHETIC_COMMIT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  CANTRIP_SYNTHETIC_BUILT_AT: "2026-10-25T00:00:00Z",
  CANTRIP_SYNTHETIC_BUILD_ID: "rust-auth-fixture",
  CANTRIP_SYNTHETIC_OVERLAY_DIGEST: "a".repeat(64),
};
delete environment.CANTRIP_RUST_SERVER_BINARY;
try {
  await run(["scripts/version.mjs", "build-package"], environment);
  await run(
    [
      "--import",
      "tsx",
      "scripts/server-rust/auth-compatibility.mjs",
      "--profile",
      "none",
      "--version-rejection",
      "--report",
      ".qa/rust-server/auth-synthetic-version.json",
    ],
    environment,
  );
} finally {
  await run(["scripts/version.mjs", "build-package"], process.env);
  await buildRustServer();
}
