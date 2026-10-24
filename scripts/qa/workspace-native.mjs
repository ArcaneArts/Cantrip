import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startEditorRecoveryFixture } from "./editor-recovery-fixture.mjs";
import { startWorkspaceBrowserFixture } from "./workspace-browser-fixture.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "This native QA launcher creates a macOS application bundle.",
  );
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "cantrip_app/package.json"));
const fixture = await startEditorRecoveryFixture({
  repositoryProject: true,
  nativeLoopbackOrigin: true,
});
const identifier = `art.cantrip.qa.workspace${randomUUID().replaceAll("-", "")}`;
const config = {
  identifier,
  productName: "Cantrip Workspace QA",
  build: { beforeDevCommand: "", devUrl: fixture.origin },
};
console.log(
  `QA_EVT ${JSON.stringify({ event: "native.workspace.launch", status: "info", identifier, directory: fixture.directory, origin: fixture.origin })}`,
);
let child;
let browserFixture;
let stop;
try {
  browserFixture = await startWorkspaceBrowserFixture();
  console.log(
    `QA_EVT ${JSON.stringify({ event: "native.browser.fixture", status: "info", origin: browserFixture.origin })}`,
  );
  child = spawn(
    process.execPath,
    [
      require.resolve("@tauri-apps/cli/tauri.js"),
      "dev",
      "--no-watch",
      "--runner",
      fileURLToPath(new URL("./workspace-native-runner.mjs", import.meta.url)),
      "--config",
      JSON.stringify(config),
    ],
    {
      cwd: path.join(root, "cantrip_app"),
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        CANTRIP_QA_BUNDLE_ID: identifier,
        CANTRIP_QA_FIXTURE_DIR: fixture.directory,
        CANTRIP_LOCAL_ONLY: "true",
        CANTRIP_DEVELOPMENT_KEY_VAULT: "1",
        CANTRIP_SERVER_URL: fixture.origin,
        CANTRIP_WORKER_ID: fixture.workerId,
        CANTRIP_WORKER_DATA_DIR: path.join(fixture.directory, "worker"),
        CANTRIP_DESKTOP_DATA_DIR: path.join(fixture.directory, "desktop"),
      },
    },
  );
  stop = () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  console.log(
    `QA_EVT ${JSON.stringify({ event: "native.workspace.exit", status: "info", code })}`,
  );
  process.exitCode = code ?? 1;
} finally {
  if (stop) {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  try {
    await browserFixture?.close();
  } finally {
    await fixture.close();
  }
}
