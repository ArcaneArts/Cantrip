import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/native-account-defaults", () => ({
  nativeAccountDefaults: api,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) =>
    createElement("button", props, children as never),
}));
import { NativeAccountDefaultsEditor } from "./native-account-defaults-editor";

const binding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: null,
};
const values = {
  model: "selected",
  model_reasoning_effort: "high",
  service_tier: null,
};
const readback = {
  snapshot: {
    version: "v1",
    stored: { model: "old" },
    effective: { model: "override" },
  },
  write: null,
  verification: "read",
};
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(async () => {
  api.mockReset();
  api.mockResolvedValue(readback);
  await act(async () => {
    renderer = TestRenderer.create(
      <NativeAccountDefaultsEditor
        binding={binding}
        identity={identity}
        values={values}
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});
const button = (label: string) =>
  renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes(label))!;
const click = async (label: string) => {
  await act(async () => button(label).props.onClick());
};
describe("explicit account defaults editor", () => {
  it("does nothing on mount and previews an actual read before a separate write", async () => {
    expect(api).not.toHaveBeenCalled();
    expect(button("Save selection as account defaults")).toBeUndefined();
    await click("Read account defaults");
    expect(api.mock.calls[0]![0]).not.toHaveProperty("write");
    api.mockResolvedValue({
      ...readback,
      verification: "confirmed",
      write: { version: "v2", status: "ok" },
    });
    await click("Save selection as account defaults");
    expect(api.mock.calls[1]![0]).toMatchObject({
      binding,
      identity,
      write: { expectedVersion: "v1", values },
    });
    expect(api.mock.calls[0]![0].operationId).not.toBe(
      api.mock.calls[1]![0].operationId,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Saved and verified");
  });
  it("requires another read after an uncertain write and never retries automatically", async () => {
    await click("Read account defaults");
    api.mockRejectedValue(new Error("transport lost"));
    await click("Save selection as account defaults");
    expect(api).toHaveBeenCalledTimes(2);
    expect(button("Save selection as account defaults")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "write was not confirmed",
    );
  });
  it("reports a confirmed write with failed readback as saved but unverified", async () => {
    await click("Read account defaults");
    api.mockResolvedValue({
      snapshot: null,
      write: { status: "ok", version: "v2" },
      verification: "unavailable",
    });
    await click("Save selection as account defaults");
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Saved, but readback failed",
    );
    expect(button("Save selection as account defaults")).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("discards late readback when the selected account source changes", async () => {
    let release!: (result: unknown) => void;
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await click("Read account defaults");
    await act(async () =>
      renderer.update(
        <NativeAccountDefaultsEditor
          binding={{ ...binding, bindingId: "other" }}
          identity={identity}
          values={values}
        />,
      ),
    );
    await act(async () => {
      release(readback);
    });
    expect(button("Save selection as account defaults")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Saved:");
  });
});
