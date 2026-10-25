import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

import {
  openLocalLogsDirectory,
  logDumpSources,
  dumpLocalLogs,
  readLocalServiceLogs,
} from "./local-service-logs";

describe("local service log bridge", () => {
  it("selects local service logs and only workers for the active server", () => {
    const workers = [
      {
        name: "remote",
        running: true,
        serverUrl: "https://remote.example",
        workerId: "desktop-remote",
      },
      {
        name: "other",
        running: true,
        serverUrl: "https://other.example",
        workerId: "desktop-other",
      },
    ];
    expect(
      logDumpSources(
        "http://localhost:4310",
        "http://localhost:4310/",
        workers,
      ),
    ).toEqual([
      { source: "client" },
      { source: "server" },
      { source: "worker" },
    ]);
    expect(
      logDumpSources(
        "https://remote.example/",
        "http://localhost:4310",
        workers,
      ),
    ).toEqual([
      { source: "client" },
      { source: "linkedWorker", workerId: "desktop-remote" },
    ]);
  });

  it("still dumps client logs when optional source discovery fails", async () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === "dump_local_logs"
        ? Promise.resolve({
            directory: "/Downloads/Cantrip-logs-test",
            files: ["client.jsonl"],
            warnings: [],
          })
        : Promise.reject(new Error("unavailable")),
    );
    const result = await dumpLocalLogs("https://remote.example");
    expect(tauri.invoke).toHaveBeenCalledWith("dump_local_logs", {
      sources: [{ source: "client" }],
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("rejects dumps outside the desktop app", async () => {
    tauri.isTauri.mockReturnValue(false);
    await expect(dumpLocalLogs("https://remote.example")).rejects.toThrow(
      "desktop app",
    );
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(true);
  });

  it("sends a fixed source selector and bounded cursor request", async () => {
    tauri.invoke.mockResolvedValue({
      records: [],
      nextCursor: 4,
      oldestCursor: null,
      latestCursor: 4,
      hasMore: false,
      truncated: false,
    });
    await readLocalServiceLogs(
      { source: "linkedWorker", workerId: "desktop-worker" },
      { afterCursor: 4, limit: 100, minimumLevel: "warn" },
    );
    expect(tauri.invoke).toHaveBeenCalledWith("read_local_service_logs", {
      request: {
        source: "linkedWorker",
        workerId: "desktop-worker",
        afterCursor: 4,
        limit: 100,
        minimumLevel: "warn",
      },
    });
  });

  it("passes a newest-first cursor without accepting a filesystem path", async () => {
    tauri.invoke.mockResolvedValue({
      records: [],
      nextCursor: 400,
      oldestCursor: 1,
      latestCursor: 400,
      hasMore: true,
      truncated: false,
    });
    await readLocalServiceLogs(
      { source: "client" },
      { beforeCursor: Number.MAX_SAFE_INTEGER, limit: 100 },
    );
    expect(tauri.invoke).toHaveBeenCalledWith("read_local_service_logs", {
      request: {
        source: "client",
        beforeCursor: Number.MAX_SAFE_INTEGER,
        limit: 100,
      },
    });
  });

  it("cannot read local files from a browser build", async () => {
    tauri.isTauri.mockReturnValue(false);
    await expect(readLocalServiceLogs({ source: "server" })).rejects.toThrow(
      "desktop app",
    );
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("opens only the fixed native logs directory without accepting a path", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    await openLocalLogsDirectory();
    expect(tauri.invoke).toHaveBeenCalledWith("open_local_logs_directory");
  });
});
