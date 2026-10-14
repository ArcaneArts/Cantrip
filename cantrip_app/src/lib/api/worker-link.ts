import {
  workerLinkSessionSchema,
  workerLinkSessionOpenRequestSchema,
  type WorkerLinkRoute,
  workerLinkRouteUpdateRequestSchema,
  type WorkerLinkTelemetrySample,
  workerLinkTelemetryBatchSchema,
  directAttachmentTicketSchema,
  workerLinkDirectActivationSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkPeerSessionOpenRequestSchema,
  type WorkerLinkPeerSignalEnvelope,
  workerLinkPeerSignalBatchSchema,
  type WorkerLinkPeerMailboxReadRequest,
  workerLinkPeerMailboxSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkResourceGrantSchema,
  workerLinkTerminalGrantRequestSchema,
  workerLinkRemoteSurfaceGrantRequestSchema,
  workerLinkObservationGrantRequestSchema,
  workerLinkTunnelGrantSchema,
  workerLinkTunnelGrantRequestSchema,
  workerLinkLeaseSchema,
  directTransportTelemetrySchema,
} from "@cantrip/protocol";
import { post, request, BOUND_API_REQUEST_BEHAVIOR } from "@/lib/api-client";

export async function createWorkerLinkSession(
  workerId: string,
  clientInstanceId: string,
) {
  return workerLinkSessionSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/worker-link/sessions`,
      workerLinkSessionOpenRequestSchema.parse({ clientInstanceId }),
    ),
  );
}

export async function renewWorkerLinkSession(
  sessionId: string,
  signal?: AbortSignal,
) {
  return workerLinkSessionSchema.parse(
    await request(`/api/worker-links/${encodeURIComponent(sessionId)}/renew`, {
      method: "POST",
      body: "{}",
      signal,
    }),
  );
}

export async function updateWorkerLinkRoute(
  sessionId: string,
  preferredRoute: WorkerLinkRoute,
) {
  return workerLinkSessionSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/route`,
      workerLinkRouteUpdateRequestSchema.parse({ preferredRoute }),
    ),
  );
}

export async function recordWorkerLinkTelemetry(
  sessionId: string,
  routeGeneration: number,
  samples: WorkerLinkTelemetrySample[],
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/telemetry`,
    workerLinkTelemetryBatchSchema.parse({ routeGeneration, samples }),
  );
}

export async function createWorkerLinkDirectTicket(sessionId: string) {
  return directAttachmentTicketSchema.parse(
    await post(`/api/worker-links/${encodeURIComponent(sessionId)}/direct`, {}),
  );
}

export async function activateWorkerLinkDirectTicket(
  sessionId: string,
  capabilityId: string,
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/direct-activate`,
    workerLinkDirectActivationSchema.parse({ capabilityId }),
  );
}

export async function createWorkerLinkPeerSession(
  sessionId: string,
  routeGeneration: number,
  route: "lan" | "wan",
) {
  return workerLinkPeerSessionDescriptorSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/peers`,
      workerLinkPeerSessionOpenRequestSchema.parse({ routeGeneration, route }),
    ),
  );
}

export async function sendWorkerLinkPeerSignals(
  sessionId: string,
  peerSessionId: string,
  signals: WorkerLinkPeerSignalEnvelope[],
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}/signals`,
    workerLinkPeerSignalBatchSchema.parse({ signals }),
  );
}

export async function readWorkerLinkPeerMailbox(
  sessionId: string,
  peerSessionId: string,
  input: Partial<WorkerLinkPeerMailboxReadRequest> = {},
) {
  return workerLinkPeerMailboxSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}/mailbox`,
      workerLinkPeerMailboxReadRequestSchema.parse(input),
    ),
  );
}

export async function deleteWorkerLinkPeerSession(
  sessionId: string,
  peerSessionId: string,
): Promise<void> {
  await request(
    `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}`,
    { method: "DELETE" },
  );
}

export async function createTerminalWorkerLinkGrant(
  sessionId: string,
  terminalId: string,
  operationId: string,
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/grant`,
      workerLinkTerminalGrantRequestSchema.parse({ operationId }),
    ),
  );
}

export async function createRemoteSurfaceWorkerLinkGrant(
  sessionId: string,
  surfaceId: string,
  viewport: { width: number; height: number; devicePixelRatio: number },
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/remote-surfaces/${encodeURIComponent(surfaceId)}/grant`,
      workerLinkRemoteSurfaceGrantRequestSchema.parse({ viewport }),
    ),
  );
}

export async function createWorkerObservationGrant(
  sessionId: string,
  topics: Array<"chat-progress" | "filesystem" | "worktree" | "runtime">,
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/observations/grant`,
      workerLinkObservationGrantRequestSchema.parse({ topics }),
    ),
  );
}

export async function createTunnelWorkerLinkGrant(
  sessionId: string,
  attachmentId: string,
  input: { diagnosticTraceId?: string } = {},
) {
  return workerLinkTunnelGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/tunnel-attachments/${encodeURIComponent(attachmentId)}/grant`,
      workerLinkTunnelGrantRequestSchema.parse(input),
    ),
  );
}

export async function renewWorkerLinkGrant(
  sessionId: string,
  grantId: string,
  signal?: AbortSignal,
) {
  return workerLinkLeaseSchema.parse(
    await request(
      `/api/worker-links/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}/renew`,
      { method: "POST", body: "{}", signal },
    ),
  );
}

export async function deleteWorkerLinkGrant(
  sessionId: string,
  grantId: string,
): Promise<void> {
  await request(
    `/api/worker-links/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  );
}

export async function deleteWorkerLinkSession(
  sessionId: string,
): Promise<void> {
  await request(`/api/worker-links/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function deleteDirectAttachment(
  capabilityId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/direct-attachments/${encodeURIComponent(capabilityId)}`,
    {
      method: "DELETE",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function recordDirectAttachmentTelemetry(
  capabilityId: string,
  telemetry: Parameters<typeof directTransportTelemetrySchema.parse>[0],
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/direct-attachments/${encodeURIComponent(capabilityId)}/telemetry`,
    {
      body: JSON.stringify(directTransportTelemetrySchema.parse(telemetry)),
      method: "POST",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}
