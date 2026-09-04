import { execFileSync } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEVTOP_PORTS = Object.freeze([4310, 4311, 1420]);

const POSITIVE_INTEGER = /^[1-9]\d*$/u;

export function parsePidList(output) {
  return [
    ...new Set(
      String(output)
        .split(/\s+/u)
        .filter((value) => POSITIVE_INTEGER.test(value))
        .map(Number),
    ),
  ];
}

export function parseUnixProcessTable(output) {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter(Boolean);
}

export function collectProcessTreePids(rootPid, processes) {
  const childrenByParent = new Map();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const result = [];
  const pending = [rootPid];
  const visited = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    result.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return result;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

const CUA_DEVELOPMENT_LAUNCHER =
  /(?:^|[\s/])scripts\/cantrip-cua\/development-launch\.mjs(?:\s|$)/u;

function isCantripDevelopmentCommand(process, repositoryRoots) {
  const normalizedCommand = process.command.replaceAll("\\", "/");
  if (
    (normalizedCommand.includes("concurrently") &&
      (normalizedCommand.includes(
        "--names glitch,protocol,server,worker,desktop",
      ) ||
        normalizedCommand.includes(
          "--names protocol,server,worker,desktop",
        ))) ||
    /(?:^|\s)(?:.*\/)?target\/debug\/cantrip-app(?:\.exe)?(?:\s|$)/u.test(
      normalizedCommand,
    ) ||
    /--filter\s+@cantrip\/(?:app|glitch|protocol|server|worker)\s+(?:run\s+)?dev(?:\s|$)/u.test(
      normalizedCommand,
    )
  ) {
    return true;
  }

  if (
    typeof process.cwd !== "string" ||
    !repositoryRoots.some((root) => pathIsWithin(root, process.cwd))
  ) {
    return false;
  }
  const normalizedCwd = process.cwd.replaceAll("\\", "/");
  return (
    (CUA_DEVELOPMENT_LAUNCHER.test(normalizedCommand) &&
      /\/cantrip_worker$/u.test(normalizedCwd)) ||
    (/\b(?:tsx(?:\.cmd)?|cli\.mjs)\s+watch\s+src\/index\.ts(?:\s|$)/u.test(
      normalizedCommand,
    ) &&
      /\/(?:cantrip_server|cantrip_worker)$/u.test(normalizedCwd)) ||
    (/\btsc(?:\.cmd)?\s+-p\s+tsconfig\.json\s+--watch(?:\s|$)/u.test(
      normalizedCommand,
    ) &&
      /\/packages\/(?:glitch|protocol)$/u.test(normalizedCwd)) ||
    (/\bvite(?:\.cmd|\.js)?\s+--port\s+1420(?:\s|$)/u.test(normalizedCommand) &&
      /\/cantrip_app$/u.test(normalizedCwd)) ||
    (/\btauri(?:\.cmd)?\s+dev(?:\s|$)/u.test(normalizedCommand) &&
      /\/cantrip_app$/u.test(normalizedCwd))
  );
}

function highestProcessRoots(pids, processes) {
  const candidates = new Set(pids);
  const parentByPid = new Map(
    processes.map((process) => [process.pid, process.ppid]),
  );
  return pids.filter((pid) => {
    const visited = new Set([pid]);
    let parent = parentByPid.get(pid);
    while (parent && !visited.has(parent)) {
      if (candidates.has(parent)) return false;
      visited.add(parent);
      parent = parentByPid.get(parent);
    }
    return true;
  });
}

export function findLegacyDevtopRootPids(processes, repositoryRoots = []) {
  const candidates = processes
    .filter((process) => isCantripDevelopmentCommand(process, repositoryRoots))
    .map(({ pid }) => pid);
  return [...new Set(highestProcessRoots(candidates, processes))];
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

function processStartMarker(pid, platform = process.platform) {
  try {
    if (platform === "win32") {
      return runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToString('o')`,
      ]).trim();
    }
    return runCommand("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
  } catch {
    return "";
  }
}

function processWorkingDirectory(pid) {
  try {
    const output = runCommand("lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    const directory = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    return directory
      ? path.resolve(directory.replace(/ \(deleted\)$/u, ""))
      : null;
  } catch {
    return null;
  }
}

function commandMayNeedWorkingDirectory(command) {
  return (
    CUA_DEVELOPMENT_LAUNCHER.test(command.replaceAll("\\", "/")) ||
    /(?:^|[\\/\s])(?:concurrently|pnpm|tauri|tsc|tsx|vite)(?:\.cmd)?(?:[\\/\s]|$)|cantrip-app/u.test(
      command,
    )
  );
}

function unixProcessSnapshot(includeWorkingDirectories = false) {
  try {
    const processes = parseUnixProcessTable(
      runCommand("ps", ["-axo", "pid=,ppid=,command="]),
    );
    if (!includeWorkingDirectories) return processes;
    return processes.map((process) => ({
      ...process,
      cwd: commandMayNeedWorkingDirectory(process.command)
        ? processWorkingDirectory(process.pid)
        : null,
    }));
  } catch {
    return [];
  }
}

export function resolveRepositoryCommonDirectory(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const commonDirectory = runCommand("git", [
    "-C",
    root,
    "rev-parse",
    "--git-common-dir",
  ]).trim();
  return path.resolve(root, commonDirectory);
}

function repositoryWorktreeRoots(repositoryRoot) {
  try {
    return runCommand("git", [
      "-C",
      path.resolve(repositoryRoot),
      "worktree",
      "list",
      "--porcelain",
    ])
      .split(/\r?\n/u)
      .flatMap((line) => (line.startsWith("worktree ") ? [line.slice(9)] : []))
      .map((root) => path.resolve(root));
  } catch {
    return [path.resolve(repositoryRoot)];
  }
}

function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

export function forceKillUnixProcessTree(
  rootPid,
  processes = unixProcessSnapshot(),
  kill = killPid,
) {
  const tree = collectProcessTreePids(rootPid, processes);
  // Kill the parent first so it cannot spawn replacement children while the
  // already-captured descendants are being removed.
  for (const pid of tree) {
    kill(pid, "SIGKILL");
  }
  return tree;
}

export function forceKillProcessTree(rootPid, platform = process.platform) {
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 0 ||
    rootPid === process.pid
  ) {
    return;
  }
  if (platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill returns a non-zero status when the process already exited.
    }
    return;
  }
  forceKillUnixProcessTree(rootPid);
}

export function forceKillSpawnedProcessGroup(
  rootPid,
  platform = process.platform,
  kill = process.kill,
) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return;
  }
  if (platform === "win32") {
    forceKillProcessTree(rootPid, platform);
    return;
  }
  try {
    kill(-rootPid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      forceKillProcessTree(rootPid, platform);
    }
  }
}

function findListeningPids(ports, platform = process.platform) {
  try {
    if (platform === "win32") {
      const portList = ports.join(",");
      return parsePidList(
        runCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-NetTCPConnection -State Listen -LocalPort ${portList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
        ]),
      );
    }
    const args = ["-nP", "-t"];
    for (const port of ports) {
      args.push(`-iTCP:${port}`);
    }
    args.push("-sTCP:LISTEN");
    return parsePidList(runCommand("lsof", args));
  } catch {
    return [];
  }
}

export function forceKillDevelopmentPortListeners(
  ports = DEVTOP_PORTS,
  platform = process.platform,
  repositoryRoot = null,
) {
  const pids = findListeningPids(ports, platform).filter(
    (pid) => pid !== process.pid,
  );
  const processes =
    platform !== "win32" && repositoryRoot ? unixProcessSnapshot(true) : [];
  const developmentRoots = new Set(
    repositoryRoot
      ? findLegacyDevtopRootPids(
          processes,
          repositoryWorktreeRoots(repositoryRoot),
        )
      : [],
  );
  const parentByPid = new Map(
    processes.map((process) => [process.pid, process.ppid]),
  );
  for (const pid of pids) {
    let target = pid;
    let parent = parentByPid.get(pid);
    const visited = new Set([pid]);
    while (parent && !visited.has(parent)) {
      if (developmentRoots.has(parent)) target = parent;
      visited.add(parent);
      parent = parentByPid.get(parent);
    }
    if (platform === "win32") {
      forceKillProcessTree(target, platform);
    } else {
      forceKillUnixProcessTree(target, processes);
    }
  }
  return pids;
}

export function forceKillLegacyDevtop(repositoryRoot = null) {
  if (process.platform === "win32") {
    try {
      const pids = parsePidList(
        runCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} -and ((($_.CommandLine -like '*concurrently*--names glitch,protocol,server,worker,desktop*') -or ($_.CommandLine -like '*concurrently*--names protocol,server,worker,desktop*')) -or ($_.CommandLine -match 'target[\\\\/]debug[\\\\/]cantrip-app(?:\\.exe)?')) } | Select-Object -ExpandProperty ProcessId`,
        ]),
      );
      for (const pid of pids) {
        forceKillProcessTree(pid, process.platform);
      }
      return pids;
    } catch {
      return [];
    }
  }
  const processes = unixProcessSnapshot(Boolean(repositoryRoot));
  const roots = findLegacyDevtopRootPids(
    processes,
    repositoryRoot ? repositoryWorktreeRoots(repositoryRoot) : [],
  ).filter((pid) => pid !== process.pid);
  for (const pid of roots) {
    forceKillUnixProcessTree(pid, processes);
  }
  return roots;
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function identityMatches(identity) {
  return (
    Number.isSafeInteger(identity?.pid) &&
    identity.pid > 0 &&
    typeof identity.start === "string" &&
    identity.start.length > 0 &&
    processStartMarker(identity.pid) === identity.start
  );
}

async function waitForIdentitiesToExit(identities, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (identities.some(identityMatches)) {
    if (Date.now() >= deadline) {
      throw new Error("Previous devtop processes did not stop after SIGKILL.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function forceKillRecordedDevtop(stateFile, repositoryKey) {
  const state = await readState(stateFile);
  if (state?.repositoryKey !== path.resolve(repositoryKey)) {
    await rm(stateFile, { force: true });
    return [];
  }

  const wrapper = identityMatches(state.wrapper) ? state.wrapper : null;
  const child = identityMatches(state.child) ? state.child : null;
  const identities = [wrapper, child].filter(Boolean);
  // Stop the wrapper first so it cannot rewrite the shared ownership record
  // while a replacement devtop is taking over. The child is a detached
  // process-group leader; kill the group as well as the captured tree so a
  // watcher cannot race the snapshot by spawning a replacement service.
  if (wrapper) forceKillProcessTree(wrapper.pid);
  if (child) forceKillSpawnedProcessGroup(child.pid);
  await waitForIdentitiesToExit(identities);
  await rm(stateFile, { force: true });
  return identities.map(({ pid }) => pid);
}

export function createDevtopState(
  repositoryRoot,
  repositoryKey = repositoryRoot,
) {
  return {
    repositoryRoot: path.resolve(repositoryRoot),
    repositoryKey: path.resolve(repositoryKey),
    wrapper: {
      pid: process.pid,
      start: processStartMarker(process.pid),
    },
    child: null,
  };
}

export function setDevtopStateChild(state, childPid) {
  state.child = Number.isSafeInteger(childPid)
    ? { pid: childPid, start: processStartMarker(childPid) }
    : null;
}

export async function writeDevtopState(stateFile, state) {
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryFile, stateFile);
}

export async function clearOwnedDevtopState(stateFile, state) {
  if (!state?.wrapper) {
    return;
  }
  const recorded = await readState(stateFile);
  if (
    recorded?.wrapper?.pid === state.wrapper.pid &&
    recorded?.wrapper?.start === state.wrapper.start
  ) {
    await rm(stateFile, { force: true });
  }
}
