import {
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  tunnelUserCreateSchema,
  tunnelUserWireCreateSchema,
  tunnelUserUpdateSchema,
  tunnelUserWireUpdateSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentCreateSchema,
} from "@cantrip/protocol";
import { request, post, BOUND_API_REQUEST_BEHAVIOR } from "@/lib/api-client";
import {
  openTunnelSummary,
  openTunnelContentRecord,
  protectTunnelContentRecord,
  createTunnelDataProtection,
} from "@/lib/tunnel-content-encryption";
import type {
  TunnelUserCreate,
  TunnelUserUpdate,
  TunnelAttachmentCreate,
} from "@cantrip/protocol";
import { TunnelWorkerReadinessRequestCache } from "@/lib/tunnel-worker-readiness-cache";
import { getClientSession } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { getActiveServerUrl } from "@/lib/server-connections";
import { ensureEndpointContentWorkerEncryption } from "@/lib/endpoint-content-worker-encryption";
import { getWorkers } from "./worker-wire";

export async function getTunnels(projectId?: string) {
  const tunnels = tunnelWireListSchema.parse(
    await request(
      projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/tunnels`
        : "/api/tunnels",
    ),
  );
  return Promise.all(tunnels.map((tunnel) => openTunnelSummary(tunnel)));
}

export async function getTunnelTransportConfiguration(
  tunnelId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  const wire = tunnelWireSummarySchema.parse(
    await request(
      `${options.serverUrl ?? ""}/api/tunnels/${encodeURIComponent(tunnelId)}`,
      {
        signal: options.signal,
      },
      options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
    ),
  );
  if (!wire.protectedRecord) {
    throw new Error("This tunnel does not have protected data-plane keys.");
  }
  const content = await openTunnelContentRecord({
    tunnelId,
    record: wire.protectedRecord,
    workerId: wire.destination.workerId,
  });
  return {
    dataProtection: { ...content.dataProtection },
    workerId: wire.destination.workerId,
  };
}

export async function getTunnelDataProtection(
  tunnelId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  return (await getTunnelTransportConfiguration(tunnelId, options))
    .dataProtection;
}

export async function createTunnel(input: TunnelUserCreate) {
  const parsed = tunnelUserCreateSchema.parse(input);
  await ensureTunnelWorker(parsed.destination.workerId);
  const id = crypto.randomUUID();
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name,
      description: parsed.description,
      source: { kind: "desktop-loopback" },
      destination: parsed.destination,
      dataProtection: createTunnelDataProtection(),
    },
    operationId: id,
    revision: 1,
    tunnelId: id,
    workerId: parsed.destination.workerId,
  });
  return openTunnelSummary(
    await post(
      "/api/tunnels",
      tunnelUserWireCreateSchema.parse({
        id,
        projectId: parsed.projectId,
        protocolHint: parsed.protocolHint,
        destination: {
          kind: parsed.destination.kind,
          workerId: parsed.destination.workerId,
        },
        protectedRecord,
      }),
    ),
  );
}

export async function updateTunnel(tunnelId: string, input: TunnelUserUpdate) {
  const parsed = tunnelUserUpdateSchema.parse(input);
  const currentWire = tunnelWireSummarySchema.parse(
    await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`),
  );
  if (
    !currentWire.protectedRecord ||
    currentWire.management !== "user-managed"
  ) {
    throw new Error("This tunnel does not have editable protected content.");
  }
  const currentContent = await openTunnelContentRecord({
    tunnelId,
    record: currentWire.protectedRecord,
    workerId: currentWire.destination.workerId,
  });
  const current = await openTunnelSummary(currentWire);
  const destination = parsed.destination ?? current.destination;
  if (destination.kind !== "worker-tcp") {
    throw new Error("User tunnels require a worker TCP destination.");
  }
  await ensureTunnelWorker(destination.workerId);
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name ?? current.name,
      description:
        parsed.description === undefined
          ? current.description
          : parsed.description,
      source: current.source,
      destination,
      dataProtection: currentContent.dataProtection,
    },
    operationId: crypto.randomUUID(),
    revision: currentWire.protectedRecord.revision + 1,
    tunnelId,
    workerId: destination.workerId,
  });
  return openTunnelSummary(
    await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`, {
      method: "PATCH",
      body: JSON.stringify(
        tunnelUserWireUpdateSchema.parse({
          ...(parsed.projectId === undefined
            ? {}
            : { projectId: parsed.projectId }),
          ...(parsed.protocolHint === undefined
            ? {}
            : { protocolHint: parsed.protocolHint }),
          ...(parsed.destination === undefined
            ? {}
            : {
                destination: {
                  kind: destination.kind,
                  workerId: destination.workerId,
                },
              }),
          protectedRecord,
        }),
      ),
    }),
  );
}

export async function deleteTunnel(tunnelId: string): Promise<void> {
  await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`, {
    method: "DELETE",
  });
}

export async function createTunnelAttachment(
  tunnelId: string,
  input: TunnelAttachmentCreate,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  return tunnelAttachmentCreateResultSchema.parse(
    await request(
      `${options.serverUrl ?? ""}/api/tunnels/${encodeURIComponent(tunnelId)}/attachments`,
      {
        body: JSON.stringify(tunnelAttachmentCreateSchema.parse(input)),
        method: "POST",
        signal: options.signal,
      },
      options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
    ),
  );
}

export async function deleteTunnelAttachment(
  attachmentId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/tunnel-attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: "DELETE",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function renewTunnelAttachmentLease(
  attachmentId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/tunnel-attachments/${encodeURIComponent(attachmentId)}/lease`,
    {
      method: "POST",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

const tunnelWorkerReadinessCache = new TunnelWorkerReadinessRequestCache(5_000);

export async function ensureTunnelWorker(workerId: string) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  await tunnelWorkerReadinessCache.get(
    {
      activeServerUrl: getActiveServerUrl(),
      session,
      snapshot,
      workerEncryption: worker?.encryption,
      workerId,
    },
    () =>
      ensureEndpointContentWorkerEncryption({
        domains: ["tunnel-content"],
        worker,
      }),
  );
}
