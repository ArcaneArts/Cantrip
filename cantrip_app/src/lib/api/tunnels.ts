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
  publicEndpointsMatch,
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
import {
  tunnelPublicDestinationEndpoint,
  tunnelPublicSourceEndpoint,
  tunnelContentOsSource,
} from "@cantrip/protocol/tunnel-content";

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
  if (!publicEndpointsMatch(wire, content))
    throw new Error(
      "The tunnel's private configuration differs from its canonical route.",
    );
  return {
    dataProtection: { ...content.dataProtection },
    workerId: wire.destination.workerId,
    source: content.source,
    destination: content.destination,
    revision: wire.protectedRecord.revision,
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
  const source = parsed.source ?? { kind: "desktop-loopback" as const };
  const osSource = tunnelContentOsSource({
    source,
    destination: parsed.destination,
  });
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name,
      description: parsed.description,
      source,
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
        source: tunnelPublicSourceEndpoint(source),
        destination: tunnelPublicDestinationEndpoint(parsed.destination, id),
        ...(osSource ? { osSource } : {}),
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
  const source = parsed.source ?? currentContent.source;
  if (
    destination.kind !== "worker-tcp" &&
    destination.kind !== "worker-os-tcp" &&
    destination.kind !== "worker-os-ssh" &&
    destination.kind !== "worker-os-vnc"
  ) {
    throw new Error(
      "User tunnels require a Host or CantripOS service destination.",
    );
  }
  const osSource = tunnelContentOsSource({ source, destination });
  await ensureTunnelWorker(destination.workerId);
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name ?? current.name,
      description:
        parsed.description === undefined
          ? current.description
          : parsed.description,
      source,
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
                  ...tunnelPublicDestinationEndpoint(destination, tunnelId),
                },
              }),
          source: tunnelPublicSourceEndpoint(source),
          ...(osSource ? { osSource } : {}),
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
