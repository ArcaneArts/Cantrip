// The local broker deadline must include managed-runtime startup plus the
// operation itself. Ordinary operations remain bounded here; browser pointer
// gestures and CUA use their explicit lifecycle rather than a wall-clock cutoff.
export const CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS = 55_000;
export const CANTRIP_WEB_SEARCH_ENGINE_TIMEOUT_MS = 8_000;
export const CANTRIP_WEB_SEARCH_RUNTIME_TIMEOUT_MS = 15_000;
