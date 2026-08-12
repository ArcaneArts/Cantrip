import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  directProbeResultSchema,
  type DirectProbeResult,
  type DirectRouteState,
} from "@cantrip/protocol";

import { createDirectWorkerProbe, deleteDirectAttachment } from "@/lib/api";

export interface DirectWorkerProbeOptions {
  onState?(state: DirectRouteState): void;
}

export async function probeDirectWorker(
  workerId: string,
  options: DirectWorkerProbeOptions = {},
): Promise<DirectProbeResult> {
  if (!isTauri()) {
    return directProbeResultSchema.parse({
      state: "relayed",
      reason: "Local direct transports require the Cantrip desktop app.",
      latencyMs: null,
      workerId,
      brokerInstanceId: null,
    });
  }
  options.onState?.("probing");
  const ticket = await createDirectWorkerProbe(workerId);
  try {
    const result = directProbeResultSchema.parse(
      await invoke("probe_direct_worker", { request: ticket }),
    );
    options.onState?.(result.state);
    return result;
  } catch (error) {
    options.onState?.("failed");
    return directProbeResultSchema.parse({
      state: "failed",
      reason: error instanceof Error ? error.message : String(error),
      latencyMs: null,
      workerId,
      brokerInstanceId: null,
    });
  } finally {
    ticket.secret = "";
    await deleteDirectAttachment(ticket.binding.capabilityId).catch(() => {
      // The worker consumes capabilities once; server cleanup is best effort.
    });
  }
}
