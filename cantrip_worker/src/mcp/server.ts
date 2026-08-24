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
  cantripMcpRunConfigurationCreateInputSchema,
  cantripMcpRunConfigurationCreateResultSchema,
  cantripMcpRunConfigurationDeleteInputSchema,
  cantripMcpRunConfigurationDeleteResultSchema,
  cantripMcpRunConfigurationDetectInputSchema,
  cantripMcpRunConfigurationDetectResultSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationGetResultSchema,
  cantripMcpRunConfigurationListInputSchema,
  cantripMcpRunConfigurationListResultSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationReadOutputResultSchema,
  cantripMcpRunConfigurationRestartInputSchema,
  cantripMcpRunConfigurationRestartResultSchema,
  cantripMcpRunConfigurationSecretSetInputSchema,
  cantripMcpRunConfigurationSecretSetResultSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationStartResultSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationStatusResultSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpRunConfigurationStopResultSchema,
  cantripMcpRunConfigurationUpdateInputSchema,
  cantripMcpRunConfigurationUpdateResultSchema,
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
  "Use Cantrip MCP only for Cantrip-owned state and surfaces. Call context_get first. Call tool_help with a tool name before guessing arguments; it returns exact schema generated from the live authoritative validator. Read effective policies when a summary requires the full body. List authorized targets; never guess or reuse IDs. Use run_configuration_detect to discover typed targets and run_configuration_list or run_configuration_get to obtain stable configuration IDs and exact revisions. Create and update structured definitions with explicit operation IDs; never select a configuration or worktree by display name. A Run targets Primary unless an exact worktree ID is supplied. Use explicit start, restart, stop, status, and read-output operations for one configuration/worktree runtime identity. Secret values are write-only through run_configuration_secret_set. Use the worker-authenticated Cantrip CLI as the fallback. End the turn immediately if continuationScheduled is true. Treat the binding scope as authoritative. Do not retry denied, expired, or stale calls without refreshed context.";

export type CantripMcpOperationGateway = (
  request: CantripAgentOperationRequest,
) => Promise<CantripAgentOperationResult>;

export interface CantripMcpServerOptions {
  /**
   * Do not advertise result schemas to the MCP client. Every operation still
   * parses its result with the authoritative schema before returning it. This
   * is useful for local model providers where schemas are copied into the
   * model prompt and result schemas add substantial prefill cost without
   * helping the model form a tool call.
   */
  omitToolOutputSchemas?: boolean;
}

export function operationResult(
  result: CantripAgentOperationResult,
): CallToolResult {
  return {
    content: [{ type: "text", text: result.summary }],
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
const idempotentMutationAnnotations = {
  ...mutationAnnotations,
  idempotentHint: true,
} as const;
const idempotentDestructiveMutationAnnotations = {
  ...destructiveMutationAnnotations,
  idempotentHint: true,
} as const;
const idempotentOpenWorldMutationAnnotations = {
  ...openWorldMutationAnnotations,
  idempotentHint: true,
} as const;
const idempotentDestructiveOpenWorldMutationAnnotations = {
  ...destructiveOpenWorldMutationAnnotations,
  idempotentHint: true,
} as const;

export function createCantripMcpServer(
  gateway: CantripMcpOperationGateway,
  options: CantripMcpServerOptions = {},
) {
  const server = new McpServer(
    {
      name: "cantrip",
      title: "Cantrip Worker Tools",
      version: cantripVersion.version,
    },
    { instructions: CANTRIP_MCP_INSTRUCTIONS },
  );
  const registerTool: typeof server.registerTool = (name, config, callback) =>
    server.registerTool(
      name,
      options.omitToolOutputSchemas
        ? { ...config, outputSchema: undefined }
        : config,
      callback,
    );
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
    "run_configuration_list",
    {
      title: "List Run configurations",
      description:
        "List the shared project Run configurations with stable IDs, revisions, validation diagnostics, secret availability, and current runtime summaries. Active configurations sort first.",
      inputSchema: cantripMcpRunConfigurationListInputSchema,
      outputSchema: cantripMcpRunConfigurationListResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationListResultSchema.parse(
            await gateway({
              operation: "run-configuration.list",
              arguments: {},
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_get",
    {
      title: "Get a Run configuration",
      description:
        "Read one complete shared Run configuration by the stable configuration ID returned by run_configuration_list.",
      inputSchema: cantripMcpRunConfigurationGetInputSchema,
      outputSchema: cantripMcpRunConfigurationGetResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationGetResultSchema.parse(
            await gateway({
              operation: "run-configuration.get",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_detect",
    {
      title: "Detect Run configuration targets",
      description:
        "Discover bounded, side-effect-free Shell, Node, Java, Dart, Flutter, and Rust target suggestions from the project Primary checkout. Optionally restrict discovery to one provider.",
      inputSchema: cantripMcpRunConfigurationDetectInputSchema,
      outputSchema: cantripMcpRunConfigurationDetectResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationDetectResultSchema.parse(
            await gateway({
              operation: "run-configuration.detect",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_status",
    {
      title: "Read Run configuration status",
      description:
        "Read durable runtime state for all project Run configurations or filter by an exact stable configuration ID and worktree ID.",
      inputSchema: cantripMcpRunConfigurationStatusInputSchema,
      outputSchema: cantripMcpRunConfigurationStatusResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationStatusResultSchema.parse(
            await gateway({
              operation: "run-configuration.status",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_read_output",
    {
      title: "Read Run configuration output",
      description:
        "Read bounded volatile PTY output for one exact configuration/worktree runtime. Omit worktreeId to select Primary.",
      inputSchema: cantripMcpRunConfigurationReadOutputInputSchema,
      outputSchema: cantripMcpRunConfigurationReadOutputResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationReadOutputResultSchema.parse(
            await gateway({
              operation: "run-configuration.read-output",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "worktree_list",
    {
      title: "List Cantrip worktrees",
      description:
        "List a bounded page of validated worktrees and leases that still protect work by default, without exposing worker filesystem paths. Set includeLeaseHistory to inspect released and idle Primary lease history.",
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
    "run_configuration_create",
    {
      title: "Create a Run configuration",
      description:
        "Create one structured shared Run configuration in Primary. Supply a fresh UUID operationId and a complete document whose stable UUID matches its file ID.",
      inputSchema: cantripMcpRunConfigurationCreateInputSchema,
      outputSchema: cantripMcpRunConfigurationCreateResultSchema,
      annotations: idempotentMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationCreateResultSchema.parse(
            await gateway({
              operation: "run-configuration.create",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_update",
    {
      title: "Update a Run configuration",
      description:
        "Revision-check and update one exact shared Run configuration. The requested ID, document ID, and expected revision must match the current definition.",
      inputSchema: cantripMcpRunConfigurationUpdateInputSchema,
      outputSchema: cantripMcpRunConfigurationUpdateResultSchema,
      annotations: idempotentMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationUpdateResultSchema.parse(
            await gateway({
              operation: "run-configuration.update",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_delete",
    {
      title: "Delete a Run configuration",
      description:
        "Stop all active instances, remove bound Run terminals, and revision-check deletion of one exact shared Run configuration.",
      inputSchema: cantripMcpRunConfigurationDeleteInputSchema,
      outputSchema: cantripMcpRunConfigurationDeleteResultSchema,
      annotations: idempotentDestructiveMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationDeleteResultSchema.parse(
            await gateway({
              operation: "run-configuration.delete",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_start",
    {
      title: "Start a Run configuration",
      description:
        "Start one inactive configuration/runtime identity. Omit worktreeId to target Primary or supply one exact registered worktree ID.",
      inputSchema: cantripMcpRunConfigurationStartInputSchema,
      outputSchema: cantripMcpRunConfigurationStartResultSchema,
      annotations: idempotentOpenWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationStartResultSchema.parse(
            await gateway({
              operation: "run-configuration.start",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_restart",
    {
      title: "Restart a Run configuration",
      description:
        "Immediately kill and relaunch one exact configuration/worktree runtime in its reusable Run terminal.",
      inputSchema: cantripMcpRunConfigurationRestartInputSchema,
      outputSchema: cantripMcpRunConfigurationRestartResultSchema,
      annotations: idempotentDestructiveOpenWorldMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationRestartResultSchema.parse(
            await gateway({
              operation: "run-configuration.restart",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_stop",
    {
      title: "Stop a Run configuration",
      description:
        "Gracefully stop one exact configuration/worktree runtime and force-kill its complete process group after the configured bound.",
      inputSchema: cantripMcpRunConfigurationStopInputSchema,
      outputSchema: cantripMcpRunConfigurationStopResultSchema,
      annotations: idempotentDestructiveMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationStopResultSchema.parse(
            await gateway({
              operation: "run-configuration.stop",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
    "run_configuration_secret_set",
    {
      title: "Set a Run configuration secret",
      description:
        "Set a write-only project secret reference. The worker encrypts the value before it reaches the Cantrip server, and no read operation returns plaintext.",
      inputSchema: cantripMcpRunConfigurationSecretSetInputSchema,
      outputSchema: cantripMcpRunConfigurationSecretSetResultSchema,
      annotations: idempotentMutationAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpRunConfigurationSecretSetResultSchema.parse(
            await gateway({
              operation: "run-configuration.secret-set",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
  registerTool(
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
