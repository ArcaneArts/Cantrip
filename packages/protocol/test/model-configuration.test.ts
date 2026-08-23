import { describe, expect, it } from "vitest";

import {
  agentActivitySchema,
  effectiveSubagentModelConfiguration,
  modelConfigurationSchema,
  userSettingsSchema,
} from "../src/index.js";

describe("model configuration contracts", () => {
  it("inherits the root while preserving inactive custom values", () => {
    const configuration = modelConfigurationSchema.parse({
      modelId: "root-model",
      reasoningEffort: "high",
      customSubagentModel: false,
      subagentModelId: "saved-child-model",
      subagentReasoningEffort: "medium",
    });

    expect(effectiveSubagentModelConfiguration(configuration)).toEqual({
      modelId: "root-model",
      reasoningEffort: "high",
    });
    expect(configuration.subagentModelId).toBe("saved-child-model");
  });

  it("requires a model when custom subagent configuration is active", () => {
    expect(
      modelConfigurationSchema.safeParse({
        modelId: "root-model",
        reasoningEffort: null,
        customSubagentModel: true,
        subagentModelId: null,
        subagentReasoningEffort: null,
      }).success,
    ).toBe(false);
  });

  it("defaults legacy account settings to inherited subagents", () => {
    const settings = userSettingsSchema.parse({
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 80,
      sidebarWidth: 288,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: "root-model",
    });

    expect(settings).toMatchObject({
      defaultReasoningEffort: null,
      defaultCustomSubagentModel: false,
      defaultSubagentModelId: null,
      defaultSubagentReasoningEffort: null,
    });
  });

  it("accepts encrypted agent-scoped communication activity", () => {
    const activity = agentActivitySchema.parse({
      id: "communication-1",
      type: "agentCommunication",
      status: "completed",
      kind: "followupSent",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      message: "Private follow-up",
      agentScope: {
        agentThreadId: "child-thread",
        rootThreadId: "root-thread",
        parentThreadId: "root-thread",
        rootTurnId: "root-turn",
        agentPath: ["root", "child"],
        nickname: "Explorer",
        role: "research",
        depth: 1,
        isRoot: false,
      },
    });

    expect(activity.agentScope?.agentPath).toEqual(["root", "child"]);
  });
});
