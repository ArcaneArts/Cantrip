import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cantripVersion } from "@cantrip/version";
import type {
  CantripAgentOperationRequest,
  CantripAgentOperationResult,
} from "@cantrip/protocol";
import {
  cantripMcpBrowserServicesInputSchema,
  cantripMcpBrowserServicesResultSchema,
  cantripMcpBrowserNavigateInputSchema,
  cantripMcpBrowserNavigateResultSchema,
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientFocusProjectResultSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientFocusSurfaceResultSchema,
  cantripMcpClientNotifyInputSchema,
  cantripMcpClientNotifyResultSchema,
  cantripMcpClientShowInteractionInputSchema,
  cantripMcpClientShowInteractionResultSchema,
  cantripMcpContextGetInputSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpExplorerListInputSchema,
  cantripMcpExplorerListResultSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpExplorerReadResultSchema,
  cantripMcpExplorerWriteInputSchema,
  cantripMcpExplorerWriteResultSchema,
  cantripMcpPolicyListInputSchema,
  cantripMcpPolicyListResultSchema,
  cantripMcpPolicyReadInputSchema,
  cantripMcpPolicyReadResultSchema,
  cantripMcpRunConfigListInputSchema,
  cantripMcpRunConfigListResultSchema,
  cantripMcpRunConfigReadInputSchema,
  cantripMcpRunConfigReadResultSchema,
  cantripMcpRunConfigSchemaInputSchema,
  cantripMcpRunConfigSchemaResultSchema,
  cantripMcpRunConfigActionAddInputSchema,
  cantripMcpRunConfigActionAddResultSchema,
  cantripMcpRunReadInputSchema,
  cantripMcpRunReadResultSchema,
  cantripMcpRunOpenInputSchema,
  cantripMcpRunOpenResultSchema,
  cantripMcpRunStartInputSchema,
  cantripMcpRunStartResultSchema,
  cantripMcpRunStatusInputSchema,
  cantripMcpRunStatusResultSchema,
  cantripMcpRunStopInputSchema,
  cantripMcpRunStopResultSchema,
  cantripMcpRunSetupRetryInputSchema,
  cantripMcpRunSetupRetryResultSchema,
  cantripMcpRunSetupStatusInputSchema,
  cantripMcpRunSetupStatusResultSchema,
  cantripMcpTargetInspectInputSchema,
  cantripMcpTargetInspectResultSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTargetListResultSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpTerminalReadResultSchema,
  cantripMcpTerminalRestartInputSchema,
  cantripMcpTerminalRestartResultSchema,
  cantripMcpTerminalSendInputSchema,
  cantripMcpTerminalSendResultSchema,
  cantripMcpToolHelpInputSchema,
  cantripMcpToolHelpResultSchema,
  cantripMcpWorktreeCreateInputSchema,
  cantripMcpWorktreeCreateResultSchema,
  cantripMcpWorktreeListInputSchema,
  cantripMcpWorktreeListResultSchema,
  cantripMcpWorktreeStatusInputSchema,
  cantripMcpWorktreeStatusResultSchema,
  cantripMcpWorktreeReleaseInputSchema,
  cantripMcpWorktreeReleaseResultSchema,
  cantripMcpWorktreeRemoveInputSchema,
  cantripMcpWorktreeRemoveResultSchema,
  cantripMcpWorktreeSwitchInputSchema,
  cantripMcpWorktreeSwitchResultSchema,
} from "@cantrip/protocol";

import { cantripMcpToolHelp } from "./tool-catalog.js";

export const CANTRIP_MCP_INSTRUCTIONS =
  "Use Cantrip MCP only for Cantrip-owned state and surfaces. Call context_get first. Call tool_help with a tool name before guessing arguments; it returns exact schema generated from the live authoritative validator. Prefer run_config_action_add for simple revision-checked Run action authoring; run_config_schema returns the complete document schema and example when direct TOML editing is necessary. Read effective policies when a summary requires the full body. List authorized targets; never guess or reuse IDs. Prefer the managed run tools when they are available: obtain exact action IDs and configuration revisions from run_config_list or run_config_read, and never select an action by display name. Setup runs only while a new secondary worktree is prepared or through explicit run_setup_retry; inspect run_setup_status instead of running setup before an action. A headless Run remains successful when no compatible client can create its encrypted terminal; use run_open after a client reconnects. Use the worker-authenticated Cantrip CLI as the fallback. End the turn immediately if continuationScheduled is true. Treat the binding scope as authoritative. Do not retry denied, expired, or stale calls without refreshed context.";

export type CantripMcpOperationGateway = (
  request: CantripAgentOperationRequest,
) => Promise<CantripAgentOperationResult>;

function operationResult(result: CantripAgentOperationResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function operationError(error: unknown): CallToolResult {
  const message =
    error instanceof Error && error.name !== "ZodError"
      ? error.message.slice(0, 2_000)
      : "Cantrip MCP result validation failed.";
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const browserDiscoveryAnnotations = {
  ...readAnnotations,
  openWorldHint: true,
} as const;
const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const destructiveMutationAnnotations = {
  ...mutationAnnotations,
  destructiveHint: true,
} as const;
const openWorldMutationAnnotations = {
  ...mutationAnnotations,
  openWorldHint: true,
} as const;
const destructiveOpenWorldMutationAnnotations = {
  ...destructiveMutationAnnotations,
  openWorldHint: true,
} as const;

export function createCantripMcpServer(gateway: CantripMcpOperationGateway) {
  const server = new McpServer(
    {
      name: "cantrip",
      title: "Cantrip Worker Tools",
      version: cantripVersion.version,
    },
    { instructions: CANTRIP_MCP_INSTRUCTIONS },
  );
  server.registerTool(
    "context_get",
    {
      title: "Get Cantrip context",
      description:
        "Return the server-validated project, chat lane, worker, worktree, root, permission, and mutation readiness for this task. Arguments: {}.",
      inputSchema: cantripMcpContextGetInputSchema,
      outputSchema: cantripMcpContextGetResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpContextGetResultSchema.parse(
            await gateway({ operation: "context.get", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "tool_help",
    {
      title: "Get exact Cantrip tool arguments",
      description:
        'Return the exact generated input JSON Schema, examples, and notes for one Cantrip MCP tool. Arguments: {"tool":"worktree_create"}. Use this before guessing a field name.',
      inputSchema: cantripMcpToolHelpInputSchema,
      outputSchema: cantripMcpToolHelpResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        const { tool } = cantripMcpToolHelpInputSchema.parse(arguments_);
        return operationResult(cantripMcpToolHelp(tool));
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "policy_list",
    {
      title: "List effective Cantrip policies",
      description:
        "List bounded summaries for policies effective in the bound project. Read a policy when its summary requires the current full body.",
      inputSchema: cantripMcpPolicyListInputSchema,
      outputSchema: cantripMcpPolicyListResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpPolicyListResultSchema.parse(
            await gateway({ operation: "policy.list", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "policy_read",
    {
      title: "Read an effective Cantrip policy",
      description:
        "Read the current body of one policy key returned by policy_list.",
      inputSchema: cantripMcpPolicyReadInputSchema,
      outputSchema: cantripMcpPolicyReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpPolicyReadResultSchema.parse(
            await gateway({
              operation: "policy.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "target_list",
    {
      title: "List authorized Cantrip targets",
      description:
        "List a bounded page of exact execution targets authorized for the bound project. Use returned target objects with target-specific tools.",
      inputSchema: cantripMcpTargetListInputSchema,
      outputSchema: cantripMcpTargetListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTargetListResultSchema.parse(
            await gateway({
              operation: "target.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "target_inspect",
    {
      title: "Inspect a Cantrip target",
      description:
        "Revalidate and inspect one exact target returned by target_list, including current placement and availability.",
      inputSchema: cantripMcpTargetInspectInputSchema,
      outputSchema: cantripMcpTargetInspectResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTargetInspectResultSchema.parse(
            await gateway({
              operation: "target.inspect",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_config_list",
    {
      title: "List Cantrip Run actions",
      description:
        "Read the Codex-compatible environment configuration from the registered project source and list platform-compatible actions with exact IDs and revisions.",
      inputSchema: cantripMcpRunConfigListInputSchema,
      outputSchema: cantripMcpRunConfigListResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpRunConfigListResultSchema.parse(
            await gateway({ operation: "run-config.list", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_config_read",
    {
      title: "Read a Cantrip Run action",
      description:
        "Read one exact platform-compatible action using the opaque action ID and configuration revision returned by run_config_list.",
      inputSchema: cantripMcpRunConfigReadInputSchema,
      outputSchema: cantripMcpRunConfigReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigReadResultSchema.parse(
            await gateway({
              operation: "run-config.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_config_schema",
    {
      title: "Read the Run configuration authoring schema",
      description:
        "Return the exact canonical environment.toml document schema plus complete JSON and TOML examples.",
      inputSchema: cantripMcpRunConfigSchemaInputSchema,
      outputSchema: cantripMcpRunConfigSchemaResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpRunConfigSchemaResultSchema.parse(
            await gateway({ operation: "run-config.schema", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_setup_status",
    {
      title: "Read worktree setup status",
      description:
        "Read the durable setup state and bounded worker-owned output for the bound worktree without executing setup.",
      inputSchema: cantripMcpRunSetupStatusInputSchema,
      outputSchema: cantripMcpRunSetupStatusResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpRunSetupStatusResultSchema.parse(
            await gateway({ operation: "run.setup-status", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_status",
    {
      title: "Read Cantrip Run status",
      description:
        "Read one exact Run or the latest Run in the bound worktree, refreshing its worker-owned process state when available.",
      inputSchema: cantripMcpRunStatusInputSchema,
      outputSchema: cantripMcpRunStatusResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunStatusResultSchema.parse(
            await gateway({ operation: "run.status", arguments: arguments_ }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_read",
    {
      title: "Read Cantrip Run output",
      description:
        "Read bounded in-memory PTY output for one exact Run. Output is unavailable after the owning worker loses the Run.",
      inputSchema: cantripMcpRunReadInputSchema,
      outputSchema: cantripMcpRunReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunReadResultSchema.parse(
            await gateway({ operation: "run.read", arguments: arguments_ }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_list",
    {
      title: "List Cantrip worktrees",
      description:
        "List a bounded page of validated worktrees and active leases without exposing worker filesystem paths.",
      inputSchema: cantripMcpWorktreeListInputSchema,
      outputSchema: cantripMcpWorktreeListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeListResultSchema.parse(
            await gateway({
              operation: "worktree.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_status",
    {
      title: "Read Cantrip worktree status",
      description:
        "Read bounded Git status for the current worktree or an exact worktree target from target_list.",
      inputSchema: cantripMcpWorktreeStatusInputSchema,
      outputSchema: cantripMcpWorktreeStatusResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeStatusResultSchema.parse(
            await gateway({
              operation: "worktree.status",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "explorer_list",
    {
      title: "List a Cantrip Explorer directory",
      description:
        "List a bounded page from an exact Explorer target. The worker protects the request and opens the response across the server relay.",
      inputSchema: cantripMcpExplorerListInputSchema,
      outputSchema: cantripMcpExplorerListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpExplorerListResultSchema.parse(
            await gateway({
              operation: "explorer.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "explorer_read",
    {
      title: "Read a Cantrip Explorer file",
      description:
        "Read bounded text from an exact Explorer target through the worker-protected surface stream.",
      inputSchema: cantripMcpExplorerReadInputSchema,
      outputSchema: cantripMcpExplorerReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpExplorerReadResultSchema.parse(
            await gateway({
              operation: "explorer.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "terminal_read",
    {
      title: "Read a Cantrip terminal snapshot",
      description:
        "Read a bounded terminal snapshot from an exact Terminal target through the worker-protected surface stream.",
      inputSchema: cantripMcpTerminalReadInputSchema,
      outputSchema: cantripMcpTerminalReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTerminalReadResultSchema.parse(
            await gateway({
              operation: "terminal.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "browser_services",
    {
      title: "Discover Cantrip browser services",
      description:
        "Discover a bounded list of local HTTP services available to an exact Browser target.",
      inputSchema: cantripMcpBrowserServicesInputSchema,
      outputSchema: cantripMcpBrowserServicesResultSchema,
      annotations: browserDiscoveryAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpBrowserServicesResultSchema.parse(
            await gateway({
              operation: "browser.services",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_config_action_add",
    {
      title: "Add a Cantrip Run action",
      description:
        'Append a complete action to the canonical environment.toml with revision checking. Arguments: {"name":"Run app","command":"pnpm run dev","icon":"run","platform":null,"environmentName":"Project environment"}. Omit platform for all hosts.',
      inputSchema: cantripMcpRunConfigActionAddInputSchema,
      outputSchema: cantripMcpRunConfigActionAddResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigActionAddResultSchema.parse(
            await gateway({
              operation: "run-config.action-add",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_start",
    {
      title: "Start a Cantrip Run",
      description:
        'Start one exact Codex-compatible action in the bound worktree. Arguments: {"actionId":"<from run_config_list>","configRevision":"<same result>","focus":true}. Call tool_help({"tool":"run_start"}) for the exact schema.',
      inputSchema: cantripMcpRunStartInputSchema,
      outputSchema: cantripMcpRunStartResultSchema,
      annotations: openWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunStartResultSchema.parse(
            await gateway({ operation: "run.start", arguments: arguments_ }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_open",
    {
      title: "Open a Cantrip Run terminal",
      description:
        "Materialize or reopen the exact Run as an encrypted Cantrip terminal through a compatible live client.",
      inputSchema: cantripMcpRunOpenInputSchema,
      outputSchema: cantripMcpRunOpenResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunOpenResultSchema.parse(
            await gateway({ operation: "run.open", arguments: arguments_ }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_setup_retry",
    {
      title: "Retry worktree setup",
      description:
        "Explicitly queue the Codex-compatible setup script for the bound secondary worktree. Setup is an open-world mutation and may execute arbitrary project code.",
      inputSchema: cantripMcpRunSetupRetryInputSchema,
      outputSchema: cantripMcpRunSetupRetryResultSchema,
      annotations: openWorldMutationAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpRunSetupRetryResultSchema.parse(
            await gateway({ operation: "run.setup-retry", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "run_stop",
    {
      title: "Stop a Cantrip Run",
      description:
        "Stop one exact Run and its complete worker-owned process group. The action may control external processes or services.",
      inputSchema: cantripMcpRunStopInputSchema,
      outputSchema: cantripMcpRunStopResultSchema,
      annotations: destructiveOpenWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunStopResultSchema.parse(
            await gateway({ operation: "run.stop", arguments: arguments_ }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_create",
    {
      title: "Create a Cantrip worktree",
      description:
        'Create an agent-owned worktree. New branch arguments: {"intent":"newBranch","name":"Fix name","branch":"codex/fix-name","baseRevision":"main"}; baseRevision is optional. Existing and detached variants differ; call tool_help({"tool":"worktree_create"}) for exact schemas. MCP uses baseRevision, matching CLI --base-revision (legacy --from alias).',
      inputSchema: cantripMcpWorktreeCreateInputSchema,
      outputSchema: cantripMcpWorktreeCreateResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeCreateResultSchema.parse(
            await gateway({
              operation: "worktree.create",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_switch",
    {
      title: "Switch the Cantrip worktree",
      description:
        'Schedule continuation in an exact authorized worktree. Arguments: {"target":{"kind":"worktree","projectId":"<context>","worktreeId":"<worktree_list>"},"purpose":"why"}. End the current turn immediately when continuation is scheduled.',
      inputSchema: cantripMcpWorktreeSwitchInputSchema,
      outputSchema: cantripMcpWorktreeSwitchResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeSwitchResultSchema.parse(
            await gateway({
              operation: "worktree.switch",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_release",
    {
      title: "Release the current Cantrip worktree",
      description:
        "Release a clean secondary worktree lease and schedule continuation on Primary. End this turn immediately after success.",
      inputSchema: cantripMcpWorktreeReleaseInputSchema,
      outputSchema: cantripMcpWorktreeReleaseResultSchema,
      annotations: destructiveMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeReleaseResultSchema.parse(
            await gateway({
              operation: "worktree.release",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_remove",
    {
      title: "Remove a Cantrip worktree",
      description:
        "Remove an exact clean, unused, agent-created secondary worktree while retaining its Git branch.",
      inputSchema: cantripMcpWorktreeRemoveInputSchema,
      outputSchema: cantripMcpWorktreeRemoveResultSchema,
      annotations: destructiveMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeRemoveResultSchema.parse(
            await gateway({
              operation: "worktree.remove",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "explorer_write",
    {
      title: "Write a Cantrip Explorer file",
      description:
        "Replace one bounded text file through an exact Explorer target and an expected version from explorer_read.",
      inputSchema: cantripMcpExplorerWriteInputSchema,
      outputSchema: cantripMcpExplorerWriteResultSchema,
      annotations: destructiveMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpExplorerWriteResultSchema.parse(
            await gateway({
              operation: "explorer.write",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "terminal_send",
    {
      title: "Send input to a Cantrip terminal",
      description:
        "Send bounded protected input to an exact Terminal target. The input may cause commands or external effects in that terminal.",
      inputSchema: cantripMcpTerminalSendInputSchema,
      outputSchema: cantripMcpTerminalSendResultSchema,
      annotations: destructiveOpenWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTerminalSendResultSchema.parse(
            await gateway({
              operation: "terminal.send",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "terminal_restart",
    {
      title: "Restart a Cantrip terminal service",
      description:
        "Restart the service process owned by an exact Terminal target after revalidating its placement and service capability.",
      inputSchema: cantripMcpTerminalRestartInputSchema,
      outputSchema: cantripMcpTerminalRestartResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTerminalRestartResultSchema.parse(
            await gateway({
              operation: "terminal.restart",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate a Cantrip browser",
      description:
        "Navigate an exact Browser target to a bounded HTTP or HTTPS URL using revision-checked protected browser state.",
      inputSchema: cantripMcpBrowserNavigateInputSchema,
      outputSchema: cantripMcpBrowserNavigateResultSchema,
      annotations: openWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpBrowserNavigateResultSchema.parse(
            await gateway({
              operation: "browser.open",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "client_notify",
    {
      title: "Notify an active Cantrip client",
      description:
        "Send one bounded best-effort notice to a compatible client currently active in the bound project.",
      inputSchema: cantripMcpClientNotifyInputSchema,
      outputSchema: cantripMcpClientNotifyResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpClientNotifyResultSchema.parse(
            await gateway({
              operation: "client.notify",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "client_focus_project",
    {
      title: "Focus the bound Cantrip project",
      description:
        "Ask one compatible project-active Cantrip client to focus the bound project. The request is ephemeral and may be unavailable.",
      inputSchema: cantripMcpClientFocusProjectInputSchema,
      outputSchema: cantripMcpClientFocusProjectResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpClientFocusProjectResultSchema.parse(
            await gateway({
              operation: "client.focus-project",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "client_focus_surface",
    {
      title: "Focus a Cantrip surface",
      description:
        "Ask one compatible project-active Cantrip client to focus an exact authorized Chat, Terminal, Explorer, Code, or Browser surface.",
      inputSchema: cantripMcpClientFocusSurfaceInputSchema,
      outputSchema: cantripMcpClientFocusSurfaceResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpClientFocusSurfaceResultSchema.parse(
            await gateway({
              operation: "client.focus-surface",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "client_show_interaction",
    {
      title: "Show a pending Cantrip interaction",
      description:
        "Ask a compatible client active in the bound chat to show one exact pending interaction. This does not answer the interaction.",
      inputSchema: cantripMcpClientShowInteractionInputSchema,
      outputSchema: cantripMcpClientShowInteractionResultSchema,
      annotations: mutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpClientShowInteractionResultSchema.parse(
            await gateway({
              operation: "client.show-interaction",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  return {
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
    server,
  };
}
