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

export function findLegacyDevtopRootPids(processes) {
  return [
    ...new Set(
      processes
        .filter(({ command }) => {
          const normalizedCommand = command.replaceAll("\\", "/");
          return (
            (normalizedCommand.includes("concurrently") &&
              normalizedCommand.includes(
                "--names protocol,server,worker,desktop",
              )) ||
            /(?:^|\s)(?:.*\/)?target\/debug\/cantrip-app(?:\.exe)?(?:\s|$)/u.test(
              normalizedCommand,
            )
          );
        })
        .map(({ pid }) => pid),
    ),
  ];
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

function unixProcessSnapshot() {
  try {
    return parseUnixProcessTable(
      runCommand("ps", ["-axo", "pid=,ppid=,command="]),
    );
  } catch {
    return [];
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
) {
  const pids = findListeningPids(ports, platform).filter(
    (pid) => pid !== process.pid,
  );
  for (const pid of pids) {
    forceKillProcessTree(pid, platform);
  }
  return pids;
}

export function forceKillLegacyDevtop() {
  if (process.platform === "win32") {
    try {
      const pids = parsePidList(
        runCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} -and (($_.CommandLine -like '*concurrently*--names protocol,server,worker,desktop*') -or ($_.CommandLine -match 'target[\\\\/]debug[\\\\/]cantrip-app(?:\\.exe)?')) } | Select-Object -ExpandProperty ProcessId`,
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
  const processes = unixProcessSnapshot();
  const roots = findLegacyDevtopRootPids(processes).filter(
    (pid) => pid !== process.pid,
  );
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

export async function forceKillRecordedDevtop(stateFile, repositoryRoot) {
  const state = await readState(stateFile);
  if (state?.repositoryRoot !== path.resolve(repositoryRoot)) {
    await rm(stateFile, { force: true });
    return [];
  }

  const identities = [state.child, state.wrapper].filter(identityMatches);
  for (const identity of identities) {
    forceKillProcessTree(identity.pid);
  }
  await rm(stateFile, { force: true });
  return identities.map(({ pid }) => pid);
}

export function createDevtopState(repositoryRoot) {
  return {
    repositoryRoot: path.resolve(repositoryRoot),
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
