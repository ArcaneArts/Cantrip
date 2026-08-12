import { invoke, isTauri } from "@tauri-apps/api/core";

export type DesktopWorkerStatus = {
  name: string;
  running: boolean;
  serverUrl: string;
  workerId: string;
};

export function supportsDesktopWorkers(): boolean {
  return isTauri();
}

export async function listDesktopWorkers(): Promise<DesktopWorkerStatus[]> {
  return isTauri() ? invoke<DesktopWorkerStatus[]>("list_desktop_workers") : [];
}

export async function pairDesktopWorker(input: {
  enrollmentCode: string;
  name: string;
  serverUrl: string;
}): Promise<DesktopWorkerStatus> {
  if (!isTauri()) {
    throw new Error("Adding this machine requires the Cantrip desktop app.");
  }
  return invoke<DesktopWorkerStatus>("pair_desktop_worker", input);
}

export async function forgetDesktopWorker(workerId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("forget_desktop_worker", { workerId });
}

export async function getDesktopAutostart(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("desktop_autostart_enabled") : false;
}

export async function setDesktopAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("set_desktop_autostart", { enabled });
}
