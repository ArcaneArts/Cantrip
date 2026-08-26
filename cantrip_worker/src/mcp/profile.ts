import {
  CANTRIP_MCP_TOOL_NAMES,
  type CantripAgentOperationName,
} from "@cantrip/protocol";

export const CANTRIP_MCP_STANDALONE_OPERATIONS = [
  "tool.help",
  "web.search",
  "web.read",
] as const satisfies readonly CantripAgentOperationName[];

export const CANTRIP_MCP_STANDALONE_TOOL_NAMES = [
  "tool_help",
  "web_search",
  "web_read",
] as const satisfies readonly (typeof CANTRIP_MCP_TOOL_NAMES)[number][];

export type CantripMcpProfile = "ide" | "standalone-web";

export function cantripMcpProfile(
  value: string | undefined,
): CantripMcpProfile {
  if (value === undefined || value === "ide") return "ide";
  if (value === "standalone-web") return value;
  throw new Error("Cantrip MCP profile is invalid.");
}

export function cantripMcpInstructions(profile: CantripMcpProfile): string {
  return profile === "standalone-web"
    ? "Use this managed Cantrip MCP only for web research in the current standalone Chat. Use web_search for bounded discovery and web_read with its opaque result IDs or continuation cursors for static page content. Call tool_help only for the available web tools when you need their exact argument schema. Project context, policies, targets, worktrees, surfaces, Run configurations, interactive browser sessions, and client-control tools are unavailable. Treat denied, expired, or stale calls as final until Cantrip starts a fresh turn."
    : "Use Cantrip MCP only for Cantrip-owned state, surfaces, and worker-managed web research. Call context_get first. Call tool_help with a tool name before guessing arguments; it returns exact schema generated from the live authoritative validator. Use web_search for bounded discovery and web_read with its opaque result IDs or continuation cursors for static page content. Use web_session_open only when interaction is required, take a fresh web_session_snapshot after every action, and never reuse stale element references. Read effective policies when a summary requires the full body. List authorized targets; never guess or reuse IDs. Use run_configuration_detect to discover typed targets and run_configuration_list or run_configuration_get to obtain stable configuration IDs and exact revisions. Create and update structured definitions with explicit operation IDs; never select a configuration or worktree by display name. A Run targets Primary unless an exact worktree ID is supplied. Use explicit start, restart, stop, status, and read-output operations for one configuration/worktree runtime identity. Secret values are write-only through run_configuration_secret_set. Use the worker-authenticated Cantrip CLI as the fallback. End the turn immediately if continuationScheduled is true. Treat the binding scope as authoritative. Do not retry denied, expired, or stale calls without refreshed context.";
}
