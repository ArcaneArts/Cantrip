import { describe, expect, it } from "vitest";

import {
  canRestartWorker,
  canAddThisMachine,
  desktopWorkerEnrollmentStopped,
  formatWorkerLastSeen,
  managedRuntimeLabel,
  workerPairingCommands,
} from "./worker-settings";
import {
  recoverableDesktopWorkerId,
  staleDesktopWorkerIds,
} from "@/lib/desktop-worker-recovery";

describe("worker settings helpers", () => {
  it("formats managed web runtime state without exposing failure detail", () => {
    expect(
      managedRuntimeLabel({
        component: "playwright",
        supported: true,
        state: "ready",
        installedVersion: "2026.08.22.1",
        previousVersion: null,
        latestVersion: "2026.08.22.1",
        lastCheckedAt: null,
        progress: null,
        failure: null,
      }),
    ).toBe("ready · v2026.08.22.1");
  });
  it("only offers restart for an online worker without a restart in flight", () => {
    expect(canRestartWorker({ online: true, restarting: false })).toBe(true);
    expect(canRestartWorker({ online: false, restarting: false })).toBe(false);
    expect(canRestartWorker({ online: true, restarting: true })).toBe(false);
  });

  it("formats recent and stale presence concisely", () => {
    const now = Date.parse("2026-08-11T20:00:00.000Z");
    expect(formatWorkerLastSeen("2026-08-11T19:59:50.000Z", now)).toBe(
      "just now",
    );
    expect(formatWorkerLastSeen("2026-08-11T19:53:00.000Z", now)).toBe(
      "7m ago",
    );
    expect(formatWorkerLastSeen("2026-08-11T17:00:00.000Z", now)).toBe(
      "3h ago",
    );
  });

  it("builds standalone pairing commands for both supported shells", () => {
    const commands = workerPairingCommands(
      "https://relay.cantrip.art",
      `ctwl_${"a".repeat(32)}`,
    );
    expect(commands.posix).toContain(
      "CANTRIP_SERVER_URL='https://relay.cantrip.art'",
    );
    expect(commands.posix).toContain("./bin/cantrip-worker");
    expect(commands.powershell).toContain(
      '$env:CANTRIP_SERVER_URL="https://relay.cantrip.art"',
    );
    expect(commands.powershell).toContain(".\\bin\\cantrip-worker.exe");
  });

  it("offers one-click enrollment only for an unlinked remote desktop", () => {
    expect(
      canAddThisMachine({
        desktopApp: true,
        hasInternalWorker: false,
        linkedWorkerId: null,
        serverIsRemote: true,
        serverWorkerIds: [],
      }),
    ).toBe(true);
    expect(
      canAddThisMachine({
        desktopApp: true,
        hasInternalWorker: false,
        linkedWorkerId: "desktop-1",
        serverIsRemote: true,
        serverWorkerIds: ["desktop-1"],
      }),
    ).toBe(false);
    expect(
      canAddThisMachine({
        desktopApp: true,
        hasInternalWorker: true,
        linkedWorkerId: null,
        serverIsRemote: false,
        serverWorkerIds: ["local-worker"],
      }),
    ).toBe(false);
  });

  it("recovers a retained source-owning identity instead of an empty replacement", () => {
    expect(
      recoverableDesktopWorkerId({
        candidates: [
          { repositoryCount: 1, workerId: "desktop-with-projects" },
          { repositoryCount: 0, workerId: "desktop-current" },
        ],
        linkedWorkerId: "desktop-current",
        serverWorkerIds: ["desktop-current"],
      }),
    ).toBe("desktop-with-projects");
    expect(
      recoverableDesktopWorkerId({
        candidates: [{ repositoryCount: 0, workerId: "desktop-stale" }],
        linkedWorkerId: "desktop-current",
        serverWorkerIds: ["desktop-current"],
      }),
    ).toBeNull();
  });

  it("does not offer recovery when the linked identity already owns sources", () => {
    expect(
      recoverableDesktopWorkerId({
        candidates: [
          { repositoryCount: 1, workerId: "desktop-retained" },
          { repositoryCount: 1, workerId: "desktop-current" },
        ],
        linkedWorkerId: "desktop-current",
        serverWorkerIds: ["desktop-current"],
      }),
    ).toBeNull();
  });

  it("offers the retained local identity after it is unlinked from the server", () => {
    expect(
      recoverableDesktopWorkerId({
        candidates: [{ repositoryCount: 0, workerId: "desktop-disconnected" }],
        linkedWorkerId: "desktop-disconnected",
        serverWorkerIds: [],
      }),
    ).toBe("desktop-disconnected");
  });

  it("retires only offline source-free desktop identities after pairing", () => {
    expect(
      staleDesktopWorkerIds({
        candidates: [
          { workerId: "desktop-current" },
          { workerId: "desktop-stale" },
          { workerId: "desktop-with-projects" },
          { workerId: "desktop-online" },
        ],
        selectedWorkerId: "desktop-current",
        workers: [
          {
            online: true,
            sources: [],
            workerId: "desktop-current",
          },
          {
            online: false,
            sources: [],
            workerId: "desktop-stale",
          },
          {
            online: false,
            sources: [{}],
            workerId: "desktop-with-projects",
          },
          {
            online: true,
            sources: [],
            workerId: "desktop-online",
          },
          {
            online: false,
            sources: [],
            workerId: "unrecognized-worker",
          },
        ],
      }),
    ).toEqual(["desktop-stale"]);
  });

  it("detects an enrollment worker that stopped before pairing", () => {
    const workers = [
      { running: false, workerId: "desktop-pairing" },
      { running: true, workerId: "desktop-other" },
    ];
    expect(
      desktopWorkerEnrollmentStopped({
        enrollmentPending: true,
        pairingWorkerId: "desktop-pairing",
        workers,
      }),
    ).toBe(true);
    expect(
      desktopWorkerEnrollmentStopped({
        enrollmentPending: false,
        pairingWorkerId: "desktop-pairing",
        workers,
      }),
    ).toBe(false);
    expect(
      desktopWorkerEnrollmentStopped({
        enrollmentPending: true,
        pairingWorkerId: "desktop-other",
        workers,
      }),
    ).toBe(false);
  });
});
