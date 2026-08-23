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
  cantripMcpRunConfigListInputSchema,
  cantripMcpRunConfigReadInputSchema,
  cantripMcpRunConfigSchemaInputSchema,
  cantripMcpRunConfigActionAddInputSchema,
  cantripMcpRunOpenInputSchema,
  cantripMcpRunReadInputSchema,
  cantripMcpRunSetupRetryInputSchema,
  cantripMcpRunSetupStatusInputSchema,
  cantripMcpRunStartInputSchema,
  cantripMcpRunStatusInputSchema,
  cantripMcpRunStopInputSchema,
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
  run_config_list: cantripMcpRunConfigListInputSchema,
  run_config_read: cantripMcpRunConfigReadInputSchema,
  run_config_schema: cantripMcpRunConfigSchemaInputSchema,
  run_setup_status: cantripMcpRunSetupStatusInputSchema,
  run_status: cantripMcpRunStatusInputSchema,
  run_read: cantripMcpRunReadInputSchema,
  worktree_list: cantripMcpWorktreeListInputSchema,
  worktree_status: cantripMcpWorktreeStatusInputSchema,
  explorer_list: cantripMcpExplorerListInputSchema,
  explorer_read: cantripMcpExplorerReadInputSchema,
  terminal_read: cantripMcpTerminalReadInputSchema,
  browser_services: cantripMcpBrowserServicesInputSchema,
  run_config_action_add: cantripMcpRunConfigActionAddInputSchema,
  run_start: cantripMcpRunStartInputSchema,
  run_open: cantripMcpRunOpenInputSchema,
  run_setup_retry: cantripMcpRunSetupRetryInputSchema,
  run_stop: cantripMcpRunStopInputSchema,
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
  run_config_action_add: [
    {
      name: "Run app",
      command: "pnpm run dev",
      icon: "run",
      platform: null,
      environmentName: "Project environment",
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
  run_start: [
    {
      actionId: "a".repeat(64),
      configRevision: "b".repeat(64),
      focus: true,
    },
  ],
};

const notes: Partial<Record<ToolName, string[]>> = {
  run_config_action_add: [
    "Omit platform or send null to make the action available on every host.",
    "The write is revision-checked and targets the MCP-bound worktree.",
  ],
  worktree_create: [
    "baseRevision is the same concept as the CLI --base-revision option; --from remains a CLI compatibility alias.",
    "Use only fields shown by the selected intent variant. The legacy field name from is not an MCP argument.",
  ],
  worktree_switch: [
    "Copy the complete target object from worktree_list; do not send a branch name or invent an ID.",
    "End the current turn immediately when continuationScheduled is true.",
  ],
  run_start: [
    "Copy actionId and configRevision from the same run_config_list or run_config_read result.",
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
