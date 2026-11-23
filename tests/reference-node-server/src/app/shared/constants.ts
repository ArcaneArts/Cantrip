import { YOLO_PERMISSION_PROFILE_ID } from "@cantrip/protocol";

import { DEFAULT_TASK_LAUNCH_STAGE_TIMEOUT_MS } from "../../tasks/launch-observation.js";

export const ROUTE_FAILURE_COOLDOWN_MS = 60_000;
export const DEFAULT_API_BODY_LIMIT_BYTES = 1_024 * 1_024;
export const DEFAULT_UPLOAD_LIMIT_BYTES = 25 * 1_024 * 1_024;
export const DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 8 * 1_024 * 1_024;
export const ATTACHMENT_CHUNK_BYTES = 256 * 1_024;
export const AGENT_INTERACTION_EXPIRY_SWEEP_MS = 1_000;
export const GOAL_RESUME_PROMPT =
  "Continue working toward the active goal. Reassess progress, make the next useful scoped change, validate it, and update the goal status when it is complete or genuinely blocked.";
export const TASK_SCHEDULE_POLL_MS = 1_000;
export const PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS = 10_000;
export const PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT = 4_096;
export const ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS = 5_000;
export const ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT = 4_096;
export const TUNNEL_ATTACHMENT_SECRET_TTL_MS = 2 * 60_000;
export const TUNNEL_BROWSER_PROTOCOL_PREFIX = "cantrip-tunnel-v1.";
export const TUNNEL_ATTACHMENT_LIFETIME_MS = 12 * 60 * 60_000;
export const TUNNEL_ATTACHMENT_INITIALIZE_TIMEOUT_MS = 10_000;
export const TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS = 60_000;
export const BROWSER_FLEET_DISCOVERY_TIMEOUT_MS = 20_000;
export const WORKER_LOG_STREAM_LEASE_MS = 120_000;
export const WORKER_LOG_STREAM_RENEW_MS = 60_000;
export const WORKER_LOG_STREAM_HEARTBEAT_MS = 25_000;
export const BROWSER_FLEET_DISCOVERY_WORKER_LIMIT = 64;
export const BROWSER_FLEET_DISCOVERY_SERVICE_LIMIT = 1_024;
export const EXTERNAL_CHAT_DISCOVERY_TIMEOUT_MS = 20_000;
export const EXTERNAL_CHAT_DISCOVERY_WORKER_LIMIT = 64;
export const REMOTE_DESKTOP_FLEET_TIMEOUT_MS = 20_000;
export const REMOTE_DESKTOP_FLEET_WORKER_LIMIT = 64;
export const REMOTE_DESKTOP_FLEET_TARGET_LIMIT = 4_096;
export const REMOTE_DESKTOP_FLEET_SURFACE_LIMIT = 64;
export const FINITE_WORKER_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const STREAMING_WORKER_COMMAND_TIMEOUT_MS = null;
export const TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS =
  DEFAULT_TASK_LAUNCH_STAGE_TIMEOUT_MS;

export const CONFIGURABLE_PERMISSION_PROFILES = [
  { id: ":read-only", description: "Inspection only", allowed: true },
  { id: ":workspace", description: "Workspace writes", allowed: true },
  {
    id: ":danger-full-access",
    description: "Unrestricted access with approval prompts",
    allowed: true,
  },
  {
    id: YOLO_PERMISSION_PROFILE_ID,
    description: "Unrestricted access without approval prompts",
    allowed: true,
  },
] as const;

export const MAX_PENDING_WORKER_HANDSHAKES = 32;
export const WORKER_HANDSHAKE_TIMEOUT_MS = 10_000;
export const WORKER_HANDSHAKE_LIMIT_KEY = "worker-command-handshake";
