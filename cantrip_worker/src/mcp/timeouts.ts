// The local broker deadline must include managed-runtime startup plus the
// operation itself. Keep it below Codex's one-minute MCP request ceiling while
// leaving a clear margin after the bounded SearXNG request.
export const CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS = 55_000;
export const CANTRIP_WEB_SEARCH_ENGINE_TIMEOUT_MS = 8_000;
export const CANTRIP_WEB_SEARCH_RUNTIME_TIMEOUT_MS = 15_000;
