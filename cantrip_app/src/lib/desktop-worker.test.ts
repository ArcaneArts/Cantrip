import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

import {
  forgetDesktopWorker,
  getDesktopAutostart,
  listDesktopWorkerCandidates,
  listDesktopWorkers,
  pairDesktopWorker,
  setDesktopAutostart,
} from "./desktop-worker";

describe("desktop worker bridge", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReset();
  });

  it("keeps browser clients outside the native worker lifecycle", async () => {
    tauri.isTauri.mockReturnValue(false);
    await expect(listDesktopWorkers()).resolves.toEqual([]);
    await expect(
      listDesktopWorkerCandidates("https://cantrip.example"),
    ).resolves.toEqual([]);
    await expect(getDesktopAutostart()).resolves.toBe(false);
    await expect(forgetDesktopWorker("worker-1")).resolves.toBeUndefined();
    await expect(
      pairDesktopWorker({
        enrollmentCode: "ctwl_test",
        name: "This machine",
        serverUrl: "https://cantrip.example",
      }),
    ).rejects.toThrow("desktop app");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("passes enrollment directly to the desktop host", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue({
      name: "This machine",
      running: true,
      serverUrl: "https://cantrip.example",
      workerId: "desktop-1",
    });
    await pairDesktopWorker({
      enrollmentCode: `ctwl_${"a".repeat(32)}`,
      name: "This machine",
      serverUrl: "https://cantrip.example",
      workerId: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
    });
    expect(tauri.invoke).toHaveBeenCalledWith("pair_desktop_worker", {
      enrollmentCode: `ctwl_${"a".repeat(32)}`,
      name: "This machine",
      serverUrl: "https://cantrip.example",
      workerId: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
    });
  });

  it("lists reusable identities without exposing credentials", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue([
      {
        repositoryCount: 2,
        workerId: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
      },
    ]);

    await expect(
      listDesktopWorkerCandidates("https://cantrip.example"),
    ).resolves.toEqual([
      {
        repositoryCount: 2,
        workerId: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
      },
    ]);
    expect(tauri.invoke).toHaveBeenCalledWith(
      "list_desktop_worker_candidates",
      { serverUrl: "https://cantrip.example" },
    );
  });

  it("controls launch-at-login through native commands", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue(true);
    await expect(setDesktopAutostart(true)).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("set_desktop_autostart", {
      enabled: true,
    });
  });
});
