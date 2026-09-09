import { describe, expect, it } from "vitest";
import type {
  NativeChatModelInventory,
  NativeSettingsBinding,
  NativeThreadSettings,
} from "@cantrip/protocol";
import {
  nativeModelSettingsPatch,
  nativeModelPickerMode,
  requestedNativeModelSelection,
} from "./native-model-settings";
const binding: NativeSettingsBinding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route-one",
  providerAccountId: "account",
};
const inventory: NativeChatModelInventory = {
  bindingId: "binding",
  workerId: "worker",
  providerId: "provider",
  providerAccountId: "account",
  providerKind: "chatgpt",
  models: [
    {
      id: "logical",
      routeId: "route-one",
      name: "native-one",
      reasoningEffort: null,
    },
    {
      id: "logical",
      routeId: "route-two",
      name: "native-two",
      reasoningEffort: null,
    },
  ],
};
const draft = {
  routeId: "route-two",
  model: "native-two",
  effort: "stale-low",
  serviceTier: null,
};
describe("shared native model settings intent", () => {
  it("does not fall back to legacy writes during a native state read failure or delay", () => {
    for (const status of ["pending", "error"] as const)
      expect(
        nativeModelPickerMode({ enabled: true, status, binding: undefined }),
      ).toBe("native");
    expect(
      nativeModelPickerMode({ enabled: true, status: "success", binding }),
    ).toBe("native");
    expect(
      nativeModelPickerMode({
        enabled: true,
        status: "success",
        binding: null,
      }),
    ).toBe("bootstrap");
    expect(
      nativeModelPickerMode({
        enabled: false,
        status: "pending",
        binding: undefined,
      }),
    ).toBe("bootstrap");
  });
  it("projects a pending native TUI collaboration update with actual native precedence", () => {
    const confirmed = {
      model: "before",
      effort: "low",
      serviceTier: null,
    } as NativeThreadSettings;
    expect(
      requestedNativeModelSelection(confirmed, [
        {
          operationId: "terminal-model",
          status: "accepted",
          pending: true,
          patch: {
            model: "ignored-separate-model",
            effort: "ignored-separate-effort",
            collaborationMode: {
              mode: "plan",
              settings: {
                model: "native-tui-model",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
          },
        },
      ]),
    ).toEqual({
      model: "native-tui-model",
      effort: "high",
      serviceTier: null,
      collaborationModeKind: "plan",
    });
  });

  it("preserves unavailable child fields and patches explicit inheritance independently", () => {
    expect(
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft,
        dirty: { multiAgentEnabled: true, subagentModel: true },
      }),
    ).toEqual({});
    expect(
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft: {
          ...draft,
          multiAgentEnabled: true,
          subagentModel: null,
          subagentReasoningEffort: null,
        },
        dirty: {
          multiAgentEnabled: true,
          subagentModel: true,
          subagentReasoningEffort: true,
        },
      }),
    ).toEqual({
      multiAgentEnabled: true,
      subagentModel: null,
      subagentReasoningEffort: null,
    });
    expect(() =>
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft: { ...draft, subagentModel: "another-provider-model" },
        dirty: { subagentModel: true },
      }),
    ).toThrow("provider and account");
  });

  it("writes only explicitly changed fields, preserving live native effort and service tier", () => {
    expect(
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft,
        dirty: { model: true },
      }),
    ).toEqual({ model: "native-two" });
    expect(
      nativeModelSettingsPatch({ binding, inventory, draft, dirty: {} }),
    ).toEqual({});
    expect(
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft,
        dirty: { serviceTier: true },
      }),
    ).toEqual({ serviceTier: null });
    expect(
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft: { ...draft, effort: null, serviceTier: "fast" },
        dirty: { effort: true, serviceTier: true },
      }),
    ).toEqual({ effort: null, serviceTier: "fast" });
  });
  it("does not substitute a provider/account or ambiguous native alias", () => {
    for (const changed of [
      { bindingId: "replaced" },
      { providerAccountId: "other-account" },
      { workerId: "other-worker" },
    ])
      expect(() =>
        nativeModelSettingsPatch({
          binding,
          inventory: { ...inventory, ...changed },
          draft,
          dirty: { model: true },
        }),
      ).toThrow("another native session");
    expect(() =>
      nativeModelSettingsPatch({
        binding,
        inventory,
        draft: { ...draft, routeId: "elsewhere" },
        dirty: { model: true },
      }),
    ).toThrow("provider and account");
    const aliases = {
      ...inventory,
      models: [
        ...inventory.models,
        { ...inventory.models[1]!, routeId: "alias" },
      ],
    };
    expect(() =>
      nativeModelSettingsPatch({
        binding,
        inventory: aliases,
        draft,
        dirty: { model: true },
      }),
    ).toThrow("multiple routes");
    expect(
      nativeModelSettingsPatch({
        binding: { ...binding, modelRouteId: "route-two" },
        inventory: aliases,
        draft,
        dirty: { model: true },
      }),
    ).toEqual({ model: "native-two" });
  });
  it("keeps requested pending choices distinct from confirmed settings and ignores rejected history", () => {
    const confirmed = {
      model: "native-one",
      effort: "native-new-effort",
      serviceTier: "fast",
    } as NativeThreadSettings;
    const selected = requestedNativeModelSelection(confirmed, [
      {
        operationId: "one",
        status: "dispatched",
        pending: true,
        patch: { model: "native-two" },
      },
      {
        operationId: "two",
        status: "uncertain",
        pending: true,
        patch: { serviceTier: null },
      },
      {
        operationId: "three",
        status: "rejected",
        pending: false,
        patch: { effort: "wrong" },
      },
    ]);
    expect(selected).toEqual({
      model: "native-two",
      effort: "native-new-effort",
      serviceTier: null,
    });
    expect(confirmed.model).toBe("native-one");
  });
});
