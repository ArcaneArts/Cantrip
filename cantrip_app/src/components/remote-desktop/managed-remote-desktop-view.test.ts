import { describe, expect, it } from "vitest";
import { remoteDesktopClientMessageSchema } from "@cantrip/protocol";

import {
  desktopPointerCoordinates,
  filterRemoteDesktopTargetInventory,
  fitDesktopSize,
  remoteDesktopRouteLabel,
  remoteDesktopTargetLabel,
  remoteDesktopTargetMatches,
  remoteDesktopInputCoalescingKey,
} from "./managed-remote-desktop-view";
import { filterRemoteDesktopFleetTargets } from "./remote-desktop-fleet-panel";

describe("managed Remote Desktop geometry", () => {
  it("coalesces only hover motion within the same input epoch and modifier state", () => {
    const pointer = {
      type: "pointer",
      event: "move",
      x: 10,
      y: 20,
      buttons: 0,
      inputEpoch: "11111111-1111-4111-8111-111111111111",
      inputSequence: 1,
    };
    const parse = (fields: object = {}) =>
      remoteDesktopClientMessageSchema.parse({ ...pointer, ...fields });
    expect(remoteDesktopInputCoalescingKey(parse())).toBe(
      "desktop-hover:11111111-1111-4111-8111-111111111111:0",
    );
    expect(
      remoteDesktopInputCoalescingKey(
        parse({ inputEpoch: "22222222-2222-4222-8222-222222222222" }),
      ),
    ).not.toBe(remoteDesktopInputCoalescingKey(parse()));
    expect(remoteDesktopInputCoalescingKey(parse({ modifiers: 8 }))).not.toBe(
      remoteDesktopInputCoalescingKey(parse()),
    );
    for (const fields of [
      { buttons: 1 },
      { event: "down" },
      { event: "up" },
      { event: "wheel" },
      { inputEpoch: undefined },
    ]) {
      expect(remoteDesktopInputCoalescingKey(parse(fields))).toBeUndefined();
    }
    expect(
      remoteDesktopInputCoalescingKey(
        remoteDesktopClientMessageSchema.parse({
          type: "key",
          event: "down",
          key: "a",
          code: "KeyA",
        }),
      ),
    ).toBeUndefined();
  });

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

  it("reports truthful per-lane WorkerLink routes", () => {
    expect(
      remoteDesktopRouteLabel({ interactive: "lan", realtime: "lan" }),
    ).toBe("LAN");
    expect(
      remoteDesktopRouteLabel({ interactive: "wan", realtime: "relay" }),
    ).toBe("Input WAN · Frames RELAY");
    expect(remoteDesktopRouteLabel(null)).toBeNull();
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
    expect(
      filterRemoteDesktopFleetTargets({ inventory }, "primary display"),
    ).toEqual({ monitors: inventory.monitors, windows: [] });
    expect(filterRemoteDesktopFleetTargets({ inventory }, "pensacola")).toEqual(
      { monitors: [], windows: [inventory.windows[1]] },
    );
  });
});
