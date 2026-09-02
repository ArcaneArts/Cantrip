import { describe, expect, it } from "vitest";

import { workspaceFolderPickerWorkerIds } from "./workspace-folder-picker";

describe("workspace folder picker worker matching", () => {
  it("includes desktop-managed workers for the active server", () => {
    expect(
      workspaceFolderPickerWorkerIds({
        connectionKind: "remote",
        desktopWorkers: [
          {
            name: "This machine",
            running: true,
            serverUrl: "http://localhost:4310/",
            workerId: "worker-local",
          },
          {
            name: "Other server",
            running: true,
            serverUrl: "https://elsewhere.example",
            workerId: "worker-elsewhere",
          },
        ],
        serverUrl: "http://127.0.0.1:4310",
        workerManagement: [],
      }),
    ).toEqual(new Set(["worker-local"]));
  });

  it("includes an internal worker only for a local server", () => {
    const workerManagement = [
      { internal: true, workerId: "worker-internal" },
      { internal: false, workerId: "worker-remote" },
    ];
    expect(
      workspaceFolderPickerWorkerIds({
        connectionKind: "local",
        desktopWorkers: [],
        serverUrl: "http://127.0.0.1:4310",
        workerManagement,
      }),
    ).toEqual(new Set(["worker-internal"]));
    expect(
      workspaceFolderPickerWorkerIds({
        connectionKind: "remote",
        desktopWorkers: [],
        serverUrl: "https://cantrip.example",
        workerManagement,
      }),
    ).toEqual(new Set());
  });
});
