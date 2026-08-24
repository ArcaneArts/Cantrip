import {
  CANTRIP_MCP_TOOL_NAMES,
  cantripMcpBrowserNavigateInputSchema,
  cantripMcpBrowserServicesInputSchema,
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientNotifyInputSchema,
  cantripMcpClientShowInteractionInputSchema,
  cantripMcpContextGetInputSchema,
  cantripMcpExplorerListInputSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpExplorerWriteInputSchema,
  cantripMcpPolicyListInputSchema,
  cantripMcpPolicyReadInputSchema,
  cantripMcpRunConfigurationCreateInputSchema,
  cantripMcpRunConfigurationDeleteInputSchema,
  cantripMcpRunConfigurationDetectInputSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationListInputSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationRestartInputSchema,
  cantripMcpRunConfigurationSecretSetInputSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpRunConfigurationUpdateInputSchema,
  cantripMcpTargetInspectInputSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpTerminalRestartInputSchema,
  cantripMcpTerminalSendInputSchema,
  cantripMcpToolHelpInputSchema,
  cantripMcpToolHelpResultSchema,
  cantripMcpWorktreeCreateInputSchema,
  cantripMcpWorktreeListInputSchema,
  cantripMcpWorktreeReleaseInputSchema,
  cantripMcpWorktreeRemoveInputSchema,
  cantripMcpWorktreeStatusInputSchema,
  cantripMcpWorktreeSwitchInputSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";

type ToolName = (typeof CANTRIP_MCP_TOOL_NAMES)[number];
type InputSchema = {
  toJSONSchema(): Record<string, unknown>;
};

const inputSchemas = {
  context_get: cantripMcpContextGetInputSchema,
  tool_help: cantripMcpToolHelpInputSchema,
  policy_list: cantripMcpPolicyListInputSchema,
  policy_read: cantripMcpPolicyReadInputSchema,
  target_list: cantripMcpTargetListInputSchema,
  target_inspect: cantripMcpTargetInspectInputSchema,
  run_configuration_list: cantripMcpRunConfigurationListInputSchema,
  run_configuration_get: cantripMcpRunConfigurationGetInputSchema,
  run_configuration_detect: cantripMcpRunConfigurationDetectInputSchema,
  run_configuration_status: cantripMcpRunConfigurationStatusInputSchema,
  run_configuration_read_output:
    cantripMcpRunConfigurationReadOutputInputSchema,
  worktree_list: cantripMcpWorktreeListInputSchema,
  worktree_status: cantripMcpWorktreeStatusInputSchema,
  explorer_list: cantripMcpExplorerListInputSchema,
  explorer_read: cantripMcpExplorerReadInputSchema,
  terminal_read: cantripMcpTerminalReadInputSchema,
  browser_services: cantripMcpBrowserServicesInputSchema,
  run_configuration_create: cantripMcpRunConfigurationCreateInputSchema,
  run_configuration_update: cantripMcpRunConfigurationUpdateInputSchema,
  run_configuration_delete: cantripMcpRunConfigurationDeleteInputSchema,
  run_configuration_start: cantripMcpRunConfigurationStartInputSchema,
  run_configuration_restart: cantripMcpRunConfigurationRestartInputSchema,
  run_configuration_stop: cantripMcpRunConfigurationStopInputSchema,
  run_configuration_secret_set: cantripMcpRunConfigurationSecretSetInputSchema,
  worktree_create: cantripMcpWorktreeCreateInputSchema,
  worktree_switch: cantripMcpWorktreeSwitchInputSchema,
  worktree_release: cantripMcpWorktreeReleaseInputSchema,
  worktree_remove: cantripMcpWorktreeRemoveInputSchema,
  explorer_write: cantripMcpExplorerWriteInputSchema,
  terminal_send: cantripMcpTerminalSendInputSchema,
  terminal_restart: cantripMcpTerminalRestartInputSchema,
  browser_navigate: cantripMcpBrowserNavigateInputSchema,
  client_notify: cantripMcpClientNotifyInputSchema,
  client_focus_project: cantripMcpClientFocusProjectInputSchema,
  client_focus_surface: cantripMcpClientFocusSurfaceInputSchema,
  client_show_interaction: cantripMcpClientShowInteractionInputSchema,
} satisfies Record<ToolName, InputSchema>;

const examples: Partial<Record<ToolName, Array<Record<string, unknown>>>> = {
  tool_help: [{ tool: "worktree_create" }],
  run_configuration_start: [
    {
      operationId: "11111111-1111-4111-8111-111111111111",
      configurationId: "22222222-2222-4222-8222-222222222222",
      worktreeId: null,
    },
  ],
  run_configuration_secret_set: [
    {
      operationId: "11111111-1111-4111-8111-111111111111",
      reference: "project/database-url",
      value: "write-only-value",
    },
  ],
  worktree_create: [
    {
      intent: "newBranch",
      name: "System bell run",
      branch: "codex/system-bell-run",
      baseRevision: "main",
    },
    {
      intent: "existingBranch",
      name: "Review release",
      branch: "release/2.x",
    },
  ],
  worktree_switch: [
    {
      target: {
        kind: "worktree",
        projectId: "project-id-from-context_get",
        worktreeId: "worktree-id-from-worktree_list",
      },
      purpose: "Continue implementation in the isolated worktree",
    },
  ],
};

const notes: Partial<Record<ToolName, string[]>> = {
  run_configuration_create: [
    "Definitions are stored under Primary .cantrip/run-configurations with document.id as the filename.",
    "New documents should leave environment.includeCodexEnvironment enabled unless the user explicitly disables it.",
  ],
  run_configuration_update: [
    "Copy configurationId and expectedRevision from the same run_configuration_get result.",
  ],
  run_configuration_start: [
    "Omit worktreeId or send null to run in Primary; use an exact ID from worktree_list for Run in Worktree.",
    "Reuse the same operationId only when intentionally replaying the identical lifecycle request.",
  ],
  run_configuration_secret_set: [
    "The value is encrypted by the worker and is never readable back as plaintext.",
  ],
  worktree_create: [
    "baseRevision is the same concept as the CLI --base-revision option; --from remains a CLI compatibility alias.",
    "Use only fields shown by the selected intent variant. The legacy field name from is not an MCP argument.",
  ],
  worktree_switch: [
    "Copy the complete target object from worktree_list; do not send a branch name or invent an ID.",
    "End the current turn immediately when continuationScheduled is true.",
  ],
  worktree_list: [
    "By default, lease output omits released lanes and idle suspended Primary lanes while retaining suspended secondary lanes that still protect work.",
    "Set includeLeaseHistory to true only when inspecting historical lease state.",
  ],
};

export function cantripMcpToolHelp(
  tool: ToolName,
): CantripAgentOperationResult {
  const inputSchema = inputSchemas[tool].toJSONSchema();
  return cantripMcpToolHelpResultSchema.parse({
    summary: `Returned the exact input schema for ${tool}.`,
    data: {
      tool,
      inputSchema,
      examples: examples[tool] ?? [],
      notes: notes[tool] ?? [],
    },
  });
}
