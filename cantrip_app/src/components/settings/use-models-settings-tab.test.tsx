import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useModelsSettingsTab } from "./use-models-settings-tab";

const identity = vi.hoisted(() => ({ scope: "server-a:user-a" }));
vi.mock("@/lib/client-session", () => ({
  scopedClientStorageKey: (key: string) => `${identity.scope}:${key}`,
}));
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
};
let view: TestRenderer.ReactTestRenderer | undefined;
function Probe() {
  const [tab, setTab] = useModelsSettingsTab();
  return (
    <button onClick={() => setTab("provider:stable-instance-id")}>{tab}</button>
  );
}
async function mount() {
  await act(async () => {
    view = TestRenderer.create(<Probe />);
  });
}
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  values.clear();
  identity.scope = "server-a:user-a";
  vi.unstubAllGlobals();
});

it("restores the selected provider ID after remounting settings", async () => {
  vi.stubGlobal("window", { localStorage: storage });
  await mount();
  await act(async () => view!.root.findByType("button").props.onClick());
  await act(async () => view!.unmount());
  await mount();
  expect(view!.root.findByType("button").children).toEqual([
    "provider:stable-instance-id",
  ]);
});

it("keeps navigation isolated when the active server or user changes", async () => {
  vi.stubGlobal("window", { localStorage: storage });
  await mount();
  await act(async () => view!.root.findByType("button").props.onClick());
  identity.scope = "server-a:user-b";
  await act(async () => view!.update(<Probe />));
  expect(view!.root.findByType("button").children).toEqual(["general"]);
  expect(values.size).toBe(1);
  identity.scope = "server-b:user-a";
  await act(async () => view!.update(<Probe />));
  expect(view!.root.findByType("button").children).toEqual(["general"]);
  identity.scope = "server-a:user-a";
  await act(async () => view!.update(<Probe />));
  expect(view!.root.findByType("button").children).toEqual([
    "provider:stable-instance-id",
  ]);
});

it("keeps settings usable when persistence is unavailable or contains invalid data", async () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => "provider:",
      setItem: () => {
        throw new Error("Unavailable");
      },
    },
  });
  await mount();
  expect(view!.root.findByType("button").children).toEqual(["general"]);
  await act(async () => view!.root.findByType("button").props.onClick());
  expect(view!.root.findByType("button").children).toEqual([
    "provider:stable-instance-id",
  ]);
});
