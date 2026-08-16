import type { ServerBootstrap, ServiceLogRecord } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { ServerConnection } from "@/lib/server-connections";
import {
  appendServiceLogRecords,
  canReadLocalServerLogs,
  filterServiceLogRecords,
  formatServiceLogRecord,
  MAX_VIEWER_LOG_RECORDS,
  scheduleLogViewportScroll,
} from "./log-viewer-model";

const localConnection: ServerConnection = {
  id: "local",
  kind: "local",
  name: "Local",
  url: "http://127.0.0.1:57464",
};

const bootstrap = {
  server: { bootstrapMode: "tauri", deploymentMode: "local" },
} as ServerBootstrap;

function record(
  cursor: number,
  level: ServiceLogRecord["level"] = "info",
  message = `message ${cursor}`,
): ServiceLogRecord {
  return {
    cursor,
    timestamp: new Date(1_700_000_000_000 + cursor).toISOString(),
    system: "worker",
    level,
    message,
  };
}

describe("service log viewer model", () => {
  it("updates from a captured scroll position without retaining a DOM event", () => {
    const current = { height: 400, scrollTop: 0 };
    let targetAvailable = true;
    const target = {
      get scrollTop() {
        if (!targetAvailable) throw new Error("scroll target was released");
        return 176;
      },
    };
    let pendingUpdate:
      | ((viewport: typeof current) => typeof current)
      | undefined;

    scheduleLogViewportScroll(target, (update) => {
      pendingUpdate = update;
    });
    targetAvailable = false;

    const next = pendingUpdate?.(current);

    expect(next).toEqual({ height: 400, scrollTop: 176 });
    expect(current).toEqual({ height: 400, scrollTop: 0 });
  });

  it("only exposes the embedded server for the matching local Tauri deployment", () => {
    expect(
      canReadLocalServerLogs({
        bootstrap,
        connection: localConnection,
        localServerUrl: "http://127.0.0.1:57464/",
        tauriRuntime: true,
      }),
    ).toBe(true);
    expect(
      canReadLocalServerLogs({
        bootstrap,
        connection: { ...localConnection, kind: "remote" },
        localServerUrl: localConnection.url,
        tauriRuntime: true,
      }),
    ).toBe(false);
    expect(
      canReadLocalServerLogs({
        bootstrap,
        connection: localConnection,
        localServerUrl: "http://127.0.0.1:4310",
        tauriRuntime: true,
      }),
    ).toBe(false);
    expect(
      canReadLocalServerLogs({
        bootstrap,
        connection: localConnection,
        localServerUrl: localConnection.url,
        tauriRuntime: false,
      }),
    ).toBe(false);
    expect(
      canReadLocalServerLogs({
        bootstrap: {
          ...bootstrap,
          server: { ...bootstrap.server, deploymentMode: "hosted" },
        },
        connection: localConnection,
        localServerUrl: localConnection.url,
        tauriRuntime: true,
      }),
    ).toBe(false);
  });

  it("deduplicates by transport cursor and retains distinct fallback records", () => {
    const remote = appendServiceLogRecords([], [record(1)], "remote:worker");
    const duplicate = appendServiceLogRecords(
      remote,
      [record(1)],
      "remote:worker",
    );
    const fallback = appendServiceLogRecords(
      duplicate,
      [record(1, "warn", "local fallback")],
      "local:worker",
    );

    expect(duplicate).toHaveLength(1);
    expect(fallback).toHaveLength(2);
    expect(fallback.map(({ viewerKey }) => viewerKey).sort()).toEqual([
      "local:worker:1",
      "remote:worker:1",
    ]);
  });

  it("bounds the client viewer even when a source returns a large history", () => {
    const records = Array.from(
      { length: MAX_VIEWER_LOG_RECORDS + 10 },
      (_, index) => record(index + 1),
    );
    const retained = appendServiceLogRecords([], records, "remote:worker");
    expect(retained).toHaveLength(MAX_VIEWER_LOG_RECORDS);
    expect(retained[0]?.cursor).toBe(11);
  });

  it("filters by severity and formatted text", () => {
    const records = appendServiceLogRecords(
      [],
      [
        record(1, "debug", "catalog refresh"),
        record(2, "error", "socket failed"),
      ],
      "remote:worker",
    );
    expect(filterServiceLogRecords(records, "socket", "trace")).toHaveLength(1);
    expect(filterServiceLogRecords(records, "", "warn")).toHaveLength(1);
    expect(formatServiceLogRecord(records[1]!)).toContain(
      "ERROR socket failed",
    );
  });
});
