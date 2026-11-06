import type { ChatNativeSuspension } from "@cantrip/protocol";

const recoveryErrors = {
  "pause-failed":
    "The turn could not be saved. Retry Pause before closing the worker.",
  "restore-failed": "The paused turn could not be restored. Retry Resume.",
  "stop-failed": "The turn could not be stopped. Retry Stop.",
  "worker-offline": "The worker is offline. Reconnect it and retry.",
  "checkpoint-missing":
    "Saved turn data is missing. Restore it and retry Resume, or Stop this turn.",
  "checkpoint-corrupt":
    "Saved turn data is damaged. Restore a valid copy, or Stop this turn.",
  "checkpoint-incompatible":
    "Saved turn data needs a compatible runtime. Retry with that runtime, or Stop this turn.",
  "authority-changed":
    "The chat's execution environment changed. Restore its original placement and retry.",
  "storage-unavailable":
    "Saved turn storage is unavailable. Restore access and retry.",
  "runtime-unavailable":
    "The required runtime is unavailable. Restore it and retry.",
  "encryption-unavailable": "Unlock this chat's private data and retry.",
  "suspension-state-unreadable":
    "The saved pause state cannot be read. Restore it, or Stop this turn.",
};

export function nativeSuspensionView(
  state?: ChatNativeSuspension,
  pendingPause?: boolean,
) {
  const view = (
    label: string,
    status: string,
    nextPaused: boolean,
    pending = false,
  ) => ({
    label,
    status,
    nextPaused,
    pending,
    blocked: false,
    held: !!state?.pausedAt,
    error: state?.error ? recoveryErrors[state.error.code] : null,
    resumeAlso: false,
  });
  if (pendingPause !== undefined)
    return {
      ...view(
        pendingPause ? "Pausing" : "Resuming",
        pendingPause ? "Pausing at the next safe boundary…" : "Resuming…",
        pendingPause,
        true,
      ),
      error: null,
    };
  if (!state) return null;
  switch (state.phase) {
    case "pausing":
      return view("Pausing", "Pausing at the next safe boundary…", true, true);
    case "resuming":
      return view("Resuming", "Resuming…", false, true);
    case "stopping":
      return { ...view("Stopping", "Stopping…", false, true), blocked: true };
    case "paused":
      return view("Resume turn", "Paused", false);
    case "error":
      if (state.action === "stop")
        return {
          ...view("Resume unavailable", "Stop failed", false),
          blocked: true,
        };
      if (state.action === "resume" && !state.resumable && state.active)
        return {
          ...view("Retry pause", "Live Resume failed", true),
          error:
            "No durable pause was saved. Retry live Resume with the original worker, or Stop this turn.",
          resumeAlso: true,
        };
      if (state.action === "pause")
        return {
          ...view("Retry pause", "Pause could not be saved", true),
          resumeAlso: true,
        };
      if (state.resumable)
        return view("Retry resume", "Paused · resume failed", false);
      return {
        ...view("Resume unavailable", "Recovery unavailable", false),
        blocked: true,
      };
    default:
      return null;
  }
}

export function persistedTurnElapsed(
  startedAtMs: number,
  now: number,
  state?: ChatNativeSuspension,
) {
  if (
    !state?.active ||
    ["idle", "completed", "stopped", "failed"].includes(state.phase)
  )
    return null;
  const currentPause = state.pausedAt
    ? Math.max(0, now - Date.parse(state.pausedAt))
    : 0;
  return Math.max(
    0,
    now - startedAtMs - state.pausedMilliseconds - currentPause,
  );
}
