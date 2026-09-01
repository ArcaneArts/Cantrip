import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearOwnedDevtopState,
  createDevtopState,
  forceKillDevelopmentPortListeners,
  forceKillLegacyDevtop,
  forceKillRecordedDevtop,
  forceKillSpawnedProcessGroup,
  resolveRepositoryCommonDirectory,
  setDevtopStateChild,
  writeDevtopState,
} from "./devtop-processes.mjs";
import {
  developmentProfileStateDirectory,
  ensureDevtopTauriConfig,
  parseDevtopProfileArguments,
} from "./devtop-tauri-config.mjs";
import { pnpmCommand } from "./pnpm-command.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryCommonDirectory =
  resolveRepositoryCommonDirectory(repositoryRoot);
const developmentProfile = parseDevtopProfileArguments();
const stateDirectory = developmentProfileStateDirectory(
  repositoryRoot,
  developmentProfile,
);
const relativeStateDirectory =
  developmentProfile === "default"
    ? ".cantrip/dev"
    : `.cantrip/dev-profiles/${developmentProfile}`;
const packageStateDirectory = `../${relativeStateDirectory}`;
const tauriTargetDirectory = `../../${relativeStateDirectory}/tauri/target`;
const tauriConfigPath = `../${relativeStateDirectory}/tauri-dev.conf.json`;
// All Cantrip worktrees contend for the same development ports and local
// worker identity. Keep the owner record in shared Git metadata so a launch
// from one worktree can stop the complete process tree started by another.
const stateFile = path.join(
  repositoryCommonDirectory,
  "cantrip",
  "devtop-process.json",
);

let activeChild = null;
let shuttingDown = false;
let state;

function hardStopActiveChild() {
  if (activeChild?.pid) {
    forceKillSpawnedProcessGroup(activeChild.pid);
  }
}

function handleSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  hardStopActiveChild();
  void clearOwnedDevtopState(stateFile, state).finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => handleSignal(signal));
}

async function runStage(command, args) {
  if (shuttingDown) {
    return 1;
  }
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
  activeChild = child;
  setDevtopStateChild(state, child.pid);
  await writeDevtopState(stateFile, state);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  if (activeChild === child) {
    activeChild = null;
    setDevtopStateChild(state, null);
    await writeDevtopState(stateFile, state);
  }
  return exitCode;
}

function runPnpm(args) {
  const invocation = pnpmCommand(args);
  return runStage(invocation.command, invocation.arguments);
}

await Promise.all([
  mkdir(stateDirectory, { recursive: true }),
  mkdir(path.dirname(stateFile), { recursive: true }),
]);

// The canonical named identity lives in shared Git metadata. The local config
// is only a launch projection, so branch/build/worktree replacement cannot
// rotate native storage or strand the installation key.
const developmentIdentity = await ensureDevtopTauriConfig({
  profileName: developmentProfile,
  repositoryCommonDirectory,
  repositoryRoot,
});
console.log(
  `Using Cantrip development profile ${developmentProfile} (${developmentIdentity.config.identifier}).`,
);

// A new devtop owns the fixed development ports. Remove the previous tree
// immediately instead of requesting graceful shutdown and waiting for it.
await forceKillRecordedDevtop(stateFile, repositoryCommonDirectory);
forceKillLegacyDevtop(repositoryRoot);
forceKillDevelopmentPortListeners(undefined, undefined, repositoryRoot);

state = createDevtopState(repositoryRoot, repositoryCommonDirectory);
await writeDevtopState(stateFile, state);

try {
  let exitCode = await runPnpm(["run", "dev:prepare"]);
  if (exitCode !== 0 || shuttingDown) {
    process.exitCode = exitCode;
  } else {
    exitCode = await runStage(process.execPath, [
      path.join(repositoryRoot, "scripts", "prepare-dev-logs.mjs"),
      stateDirectory,
    ]);
    if (exitCode !== 0 || shuttingDown) {
      process.exitCode = exitCode;
    } else {
      // Preparation can take a while, so clear anything that claimed a devtop
      // port during the build before starting the actual services.
      forceKillDevelopmentPortListeners(undefined, undefined, repositoryRoot);
      // Keep the Tauri development binary in disposable profile-scoped output.
      // The canonical app identifier remains in shared Git metadata. A normal
      // Tauri build uses src-tauri/target and may be compiled for
      // tauri://localhost, so reusing that binary would still change the
      // WebView origin used by the legacy migration reader.
      process.exitCode = await runPnpm([
        "exec",
        "concurrently",
        "--kill-others",
        "--kill-signal",
        "SIGKILL",
        "--names",
        "glitch,protocol,server,worker,desktop",
        "--prefix-colors",
        "cyan,gray,blue,magenta,green",
        "pnpm --filter @cantrip/glitch dev",
        "pnpm --filter @cantrip/protocol dev",
        `cross-env FORCE_COLOR=1 CANTRIP_DATA_DIR=${packageStateDirectory} CANTRIP_SERVICE_LOG_DIR=${packageStateDirectory}/logs/server pnpm --filter @cantrip/server dev`,
        `node scripts/wait-for-server.mjs && cross-env FORCE_COLOR=1 CANTRIP_WORKER_DATA_DIR=${packageStateDirectory}/worker CANTRIP_SERVICE_LOG_DIR=${packageStateDirectory}/logs/worker CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP=true pnpm --filter @cantrip/worker dev`,
        `node scripts/wait-for-server.mjs && cross-env CARGO_TARGET_DIR=${tauriTargetDirectory} CANTRIP_LOCAL_ONLY=true VITE_CANTRIP_LOCAL_ONLY=true pnpm --filter @cantrip/app exec tauri dev --config ${tauriConfigPath}`,
      ]);
    }
  }
} finally {
  hardStopActiveChild();
  await clearOwnedDevtopState(stateFile, state);
}
