import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  current: { serverId: "server-a", user: { id: "owner-a" } },
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => identity.current,
  onClientSessionIdentityChanged: (listener: () => void) => {
    identity.listeners.add(listener);
    return () => identity.listeners.delete(listener);
  },
}));

let values: Map<string, string>;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.resetModules();
  identity.current = { serverId: "server-a", user: { id: "owner-a" } };
  identity.listeners.clear();
  values = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    }),
  );
});

afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("project access history", () => {
  it("remembers the most recently accessed project first across app reloads", async () => {
    let history = await import("./project-recency");
    history.recordProjectAccess("retina");
    history.recordProjectAccess("cantrip");
    history.recordProjectAccess("retina");
    expect(history.readRecentProjectIds()).toEqual(["retina", "cantrip"]);
    expect([...values.values()]).toEqual(['["retina","cantrip"]']);

    vi.resetModules();
    history = await import("./project-recency");
    expect(history.readRecentProjectIds()).toEqual(["retina", "cantrip"]);
  });

  it("keeps each server and account's history separate", async () => {
    const history = await import("./project-recency");
    history.recordProjectAccess("retina");
    identity.current = { serverId: "server-b", user: { id: "owner-a" } };
    expect(history.readRecentProjectIds()).toEqual([]);
    history.recordProjectAccess("caremap");
    identity.current = { serverId: "server-a", user: { id: "owner-b" } };
    expect(history.readRecentProjectIds()).toEqual([]);
    history.recordProjectAccess("cantrip");
    identity.current = { serverId: "server-a", user: { id: "owner-a" } };
    expect(history.readRecentProjectIds()).toEqual(["retina"]);
  });

  it("continues ordering projects when browser storage fails", async () => {
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        localStorage: {
          getItem: () => {
            throw new Error("unavailable");
          },
          setItem: () => {
            throw new Error("unavailable");
          },
        },
      }),
    );
    const history = await import("./project-recency");
    history.recordProjectAccess("retina");
    history.recordProjectAccess("cantrip");
    history.recordProjectAccess("retina");
    expect(history.readRecentProjectIds()).toEqual(["retina", "cantrip"]);
  });

  it("recovers from malformed stored history", async () => {
    values.set(
      JSON.stringify(["cantrip:project-recency:v1", "server-a", "owner-a"]),
      "not json",
    );
    const history = await import("./project-recency");
    expect(history.readRecentProjectIds()).toEqual([]);
    history.recordProjectAccess("retina");
    expect(history.readRecentProjectIds()).toEqual(["retina"]);
  });

  it("updates mounted pickers for visits, other windows, and account changes", async () => {
    const history = await import("./project-recency");
    function Probe() {
      return createElement(
        "span",
        null,
        history.useRecentProjectIds().join(","),
      );
    }
    await act(() => {
      renderer = create(createElement(Probe));
    });
    await act(() => history.recordProjectAccess("retina"));
    expect(renderer!.toJSON()).toMatchObject({ children: ["retina"] });

    const [key] = values.keys();
    values.set(key!, '["cantrip","retina"]');
    await act(() => {
      window.dispatchEvent(Object.assign(new Event("storage"), { key }));
    });
    expect(renderer!.toJSON()).toMatchObject({ children: ["cantrip,retina"] });

    await act(() => {
      identity.current = { serverId: "server-b", user: { id: "owner-a" } };
      identity.listeners.forEach((listener) => listener());
    });
    expect(renderer!.toJSON()).toMatchObject({ children: null });
  });
});
