// Acceptance-fixture teardown: validate the effect of taskkill on the owned tree.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function processes(filter = "") {
  const script = `
$ErrorActionPreference = 'Stop'
$records = @(Get-CimInstance Win32_Process ${filter} | ForEach-Object {
  ${filter ? "$process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if (!$process -or $process.HasExited) { return }" : ""}
  [PSCustomObject]@{
    id = [int]$_.ProcessId
    parent = [int]$_.ParentProcessId
    created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' }
  }
})
ConvertTo-Json -InputObject $records -Compress
`;
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 30000, windowsHide: true },
  );
  return JSON.parse(stdout);
}

export async function terminateWindowsWorkerTree(pid, deadline) {
  let owned, snapshotError;
  try {
    const all = await processes();
    const ids = new Set([pid]);
    for (;;) {
      const size = ids.size;
      for (const process of all)
        if (ids.has(process.parent)) ids.add(process.id);
      if (size === ids.size) break;
    }
    owned = all.filter((process) => ids.has(process.id));
    if (!owned.some((p) => p.id === pid) || owned.some((p) => !p.created))
      snapshotError = new Error("Could not identify the owned worker tree.");
  } catch (error) {
    snapshotError = error;
  }
  let commandExitCode = 0,
    commandError;
  // Attempt termination even if process enumeration failed. Enumeration is
  // evidence for the subsequent cleanup check, never a gate on the operation.
  try {
    await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      timeout: 30000,
      windowsHide: true,
    });
  } catch (error) {
    commandExitCode = error.code;
    commandError = error;
  }
  return async () => {
    if (snapshotError) throw snapshotError;
    const identities = new Set(owned.map((p) => `${p.id}:${p.created}`));
    const filter = owned.map((p) => `ProcessId = ${p.id}`).join(" OR ");
    for (;;) {
      const remaining = filter
        ? (await processes(`-Filter '${filter}'`)).filter((p) =>
            identities.has(`${p.id}:${p.created}`),
          )
        : [];
      if (remaining.length === 0)
        return { commandExitCode, observedProcesses: owned.length, remaining };
      if (Date.now() >= deadline)
        throw new Error(
          `Worker descendants remain after taskkill: ${JSON.stringify(remaining)}`,
          { cause: commandError },
        );
      await delay(50);
    }
  };
}
