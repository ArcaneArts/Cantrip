import { describe, expect, it, vi } from "vitest";
import {
  readProtectedNativeSettings,
  type NativeSettingsReadTarget,
} from "../src/native-settings-read.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

const scope = {
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 9) }),
};
function setup() {
  const runtime = {
    transportGeneration: "runtime-one",
    readNativeThreadSettings: vi.fn(async () => ({
      confirmed: {
        sequence: 1,
        operationId: null,
        submissionId: null,
        settings: nativeThreadSettings({
          settingsVersion: { epoch: "core", revision: "1" },
        }),
      },
      requests: [],
    })),
  };
  const target: NativeSettingsReadTarget = {
    scope,
    runtime,
    generation: "runtime-one",
  };
  return { runtime, target };
}
describe("read protection for the selected managed runtime", () => {
  it("performs exactly one native read and binds the encrypted result to its runtime", async () => {
    const { target, runtime } = setup();
    const snapshot = await readProtectedNativeSettings({
      scope,
      service,
      resolve: () => target,
    });
    expect(runtime.readNativeThreadSettings).toHaveBeenCalledExactlyOnceWith(
      "thread",
    );
    expect(snapshot.context).toMatchObject({
      chatId: "chat",
      runtimeGeneration: "runtime-one",
      settingsVersion: { epoch: "core", revision: "1" },
    });
  });
  it("cannot publish a result after the runtime or its managed association changes", async () => {
    for (const replacement of ["transport", "association", "route"] as const) {
      const { runtime, target } = setup();
      let selected = target;
      runtime.readNativeThreadSettings.mockImplementationOnce(async () => {
        if (replacement === "transport")
          runtime.transportGeneration = "runtime-two";
        else if (replacement === "association")
          selected = { ...target, runtime: { ...runtime } };
        else
          selected = {
            ...target,
            scope: { ...scope, modelRouteId: "another-route" },
          };
        return {
          confirmed: {
            sequence: 1,
            operationId: null,
            submissionId: null,
            settings: nativeThreadSettings({
              settingsVersion: { epoch: "core", revision: "1" },
            }),
          },
          requests: [],
        };
      });
      await expect(
        readProtectedNativeSettings({
          scope,
          service,
          resolve: () => selected,
        }),
      ).rejects.toThrow("current managed runtime");
    }
  });
  it("does not select a different account or create a runtime when the bound one is absent", async () => {
    const { target, runtime } = setup();
    await expect(
      readProtectedNativeSettings({ scope, service, resolve: () => undefined }),
    ).rejects.toThrow();
    await expect(
      readProtectedNativeSettings({
        scope,
        service,
        resolve: () => ({
          ...target,
          scope: { ...scope, providerAccountId: "other-account" },
        }),
      }),
    ).rejects.toThrow();
    expect(runtime.readNativeThreadSettings).not.toHaveBeenCalled();
  });
});
