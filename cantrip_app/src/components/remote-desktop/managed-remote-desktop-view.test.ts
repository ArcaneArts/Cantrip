import { describe, expect, it } from "vitest";

import {
  desktopPointerCoordinates,
  filterRemoteDesktopTargetInventory,
  fitDesktopSize,
  remoteDesktopTargetLabel,
  remoteDesktopTargetMatches,
} from "./managed-remote-desktop-view";

describe("managed Remote Desktop geometry", () => {
  it("letterboxes a worker display without distorting its aspect ratio", () => {
    expect(
      fitDesktopSize(
        { width: 1_000, height: 1_000 },
        { width: 1_920, height: 1_080 },
      ),
    ).toEqual({ width: 1_000, height: 562 });
  });

  it("maps pointer positions back to worker display coordinates", () => {
    expect(
      desktopPointerCoordinates(
        { clientX: 510, clientY: 291 },
        { left: 10, top: 10, width: 1_000, height: 562 },
        { width: 1_920, height: 1_080 },
      ),
    ).toEqual({ x: 960, y: 540 });
  });

  it("labels and restores persisted monitor and application targets", () => {
    expect(
      remoteDesktopTargetMatches(
        { kind: "monitor", id: "missing", name: "Studio Display" },
        { kind: "monitor", id: "new-id", name: "Studio Display" },
      ),
    ).toBe(true);
    expect(
      remoteDesktopTargetMatches(
        {
          kind: "window",
          id: null,
          application: "Code",
          title: "Cantrip",
        },
        {
          kind: "window",
          id: "window-2",
          application: "Code",
          title: "Cantrip",
        },
      ),
    ).toBe(true);
    expect(
      remoteDesktopTargetLabel({
        kind: "window",
        id: "window-2",
        application: "Code",
        title: "Cantrip",
      }),
    ).toBe("Code — Cantrip");
  });

  it("filters displays and application windows from one search query", () => {
    const inventory = {
      monitors: [
        {
          kind: "monitor" as const,
          id: "display-1",
          name: "Studio Display",
          x: 0,
          y: 0,
          width: 2560,
          height: 1440,
          primary: true,
        },
      ],
      windows: [
        {
          kind: "window" as const,
          id: "window-1",
          application: "Visual Studio Code",
          title: "Cantrip — Explorer",
          iconKey: "desktop-app-v1-code",
          x: 20,
          y: 30,
          width: 1200,
          height: 800,
          minimized: false,
          focused: true,
        },
        {
          kind: "window" as const,
          id: "window-2",
          application: "Maps",
          title: "Pensacola",
          iconKey: "desktop-app-v1-maps",
          x: 30,
          y: 40,
          width: 900,
          height: 700,
          minimized: false,
          focused: false,
        },
      ],
    };

    expect(filterRemoteDesktopTargetInventory(inventory, "2560")).toEqual({
      monitors: inventory.monitors,
      windows: [],
    });
    expect(filterRemoteDesktopTargetInventory(inventory, "cantrip")).toEqual({
      monitors: [],
      windows: [inventory.windows[0]],
    });
    expect(filterRemoteDesktopTargetInventory(inventory, "maps")).toEqual({
      monitors: [],
      windows: [inventory.windows[1]],
    });
  });
});
