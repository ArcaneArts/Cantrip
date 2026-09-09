import type { NativeThreadSettings } from "../../src/codex/native-thread-settings.js";

export function nativeThreadSettings(
  overrides: Partial<NativeThreadSettings> = {},
): NativeThreadSettings {
  return {
    cwd: "/unused/cantrip-thread-session-test",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    effort: "high",
    serviceTier: null,
    summary: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly" },
    activePermissionProfile: null,
    collaborationMode: {
      mode: "default",
      settings: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        developer_instructions: null,
      },
    },
    multiAgentMode: "explicitRequestOnly",
    personality: null,
    ...overrides,
  };
}
