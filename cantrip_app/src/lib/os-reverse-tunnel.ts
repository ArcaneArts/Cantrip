import {
  workerLinkLeaseSchema,
  workerLinkTunnelGrantSchema,
  type TunnelAttachmentCreate,
  type TunnelAttachmentCreateResult,
  type WorkerLinkRoute,
} from "@cantrip/protocol";
import { request, BOUND_API_REQUEST_BEHAVIOR } from "./api-client";
import {
  createTunnelAttachment,
  deleteTunnelAttachment,
  getTunnelTransportConfiguration,
} from "./api/tunnels";
import { getActiveServerUrl } from "./server-connections";
import { workerLinkManager } from "./worker-link";
import {
  openTunnelWorkerLink,
  type OpenTunnelWorkerLinkOptions,
  type TunnelWorkerLinkConnection,
} from "./tunnel-worker-link";

export interface OsReverseTunnelSummary {
  tunnelId: string;
  attachmentId: string | null;
  serverUrl: string;
  workerId: string;
  guestPort: number;
  status: "starting" | "active" | "stopping" | "failed";
  route: WorkerLinkRoute | null;
  error: string | null;
}
export interface OsReverseTunnelDependencies {
  configuration(id: string): ReturnType<typeof getTunnelTransportConfiguration>;
  create(
    id: string,
    input: TunnelAttachmentCreate,
  ): Promise<TunnelAttachmentCreateResult>;
  remove(id: string): Promise<void>;
  open(
    options: OpenTunnelWorkerLinkOptions,
  ): Promise<TunnelWorkerLinkConnection>;
}
interface Entry {
  summary: OsReverseTunnelSummary;
  dependencies: OsReverseTunnelDependencies;
  connection?: TunnelWorkerLinkConnection;
  opening?: Promise<OsReverseTunnelSummary>;
  retirement?: Promise<void>;
  cancelled: boolean;
  closed: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}
const hot = import.meta.hot?.data as
  { osReverseTunnels?: ReturnType<typeof state> } | undefined;
function state() {
  return {
    entries: new Map<string, Entry>(),
    subscribers: new Set<() => void>(),
    snapshot: [] as OsReverseTunnelSummary[],
  };
}
const runtime = hot ? (hot.osReverseTunnels ??= state()) : state();
const key = (serverUrl: string, id: string) => `${serverUrl}\0${id}`;
function publish() {
  runtime.snapshot = [...runtime.entries.values()].map((e) => ({
    ...e.summary,
  }));
  for (const listener of runtime.subscribers) listener();
}
export function subscribeOsReverseTunnels(listener: () => void) {
  runtime.subscribers.add(listener);
  return () => {
    runtime.subscribers.delete(listener);
  };
}
export function osReverseTunnelSnapshot() {
  return runtime.snapshot;
}

function defaults(serverUrl: string): OsReverseTunnelDependencies {
  const bound = (path: string, body?: unknown, method = "POST") =>
    request(
      `${serverUrl}${path}`,
      {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      BOUND_API_REQUEST_BEHAVIOR,
    );
  return {
    configuration: (id) => getTunnelTransportConfiguration(id, { serverUrl }),
    create: (id, input) => createTunnelAttachment(id, input, { serverUrl }),
    remove: (id) => deleteTunnelAttachment(id, { serverUrl }),
    open: (options) =>
      openTunnelWorkerLink(options, {
        manager: workerLinkManager,
        now: Date.now,
        createGrant: async (session, attachment, input) =>
          workerLinkTunnelGrantSchema.parse(
            await bound(
              `/api/worker-links/${encodeURIComponent(session)}/tunnel-attachments/${encodeURIComponent(attachment)}/grant`,
              input,
            ),
          ),
        renewGrant: async (session, grant) =>
          workerLinkLeaseSchema.parse(
            await bound(
              `/api/worker-links/${encodeURIComponent(session)}/grants/${encodeURIComponent(grant)}/renew`,
              {},
            ),
          ),
        revokeGrant: async (session, grant) => {
          await bound(
            `/api/worker-links/${encodeURIComponent(session)}/grants/${encodeURIComponent(grant)}`,
            undefined,
            "DELETE",
          );
        },
      }),
  };
}
function retire(entry: Entry, failed: boolean) {
  entry.closed = true;
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  entry.connection?.close();
  if (entry.retirement) return entry.retirement;
  entry.summary.status = failed ? "failed" : "stopping";
  publish();
  const work = (async () => {
    if (entry.summary.attachmentId)
      await entry.dependencies.remove(entry.summary.attachmentId);
    if (
      !failed &&
      runtime.entries.get(
        key(entry.summary.serverUrl, entry.summary.tunnelId),
      ) === entry
    )
      runtime.entries.delete(
        key(entry.summary.serverUrl, entry.summary.tunnelId),
      );
    publish();
  })();
  entry.retirement = work;
  void work.catch(() => {
    if (entry.retirement === work) entry.retirement = undefined;
  });
  return work;
}

/** Worker-owned listener: works in the browser without opening a device port. */
export function startOsReverseTunnel(
  tunnelId: string,
  options: {
    serverUrl?: string;
    dependencies?: OsReverseTunnelDependencies;
  } = {},
) {
  const serverUrl = options.serverUrl ?? getActiveServerUrl();
  if (!serverUrl) return Promise.reject(new Error("Select a Cantrip server."));
  const id = key(serverUrl, tunnelId),
    current = runtime.entries.get(id);
  if (current?.summary.status === "active")
    return Promise.resolve(current.summary);
  if (current?.summary.status === "starting" && current.opening)
    return current.opening;
  const dependencies = options.dependencies ?? defaults(serverUrl);
  const entry: Entry = {
    summary: {
      tunnelId,
      serverUrl,
      attachmentId: null,
      workerId: "",
      guestPort: 0,
      status: "starting",
      route: null,
      error: null,
    },
    dependencies,
    cancelled: false,
    closed: false,
  };
  runtime.entries.set(id, entry);
  publish();
  const active = () => {
    if (
      entry.cancelled ||
      entry.closed ||
      runtime.entries.get(id) !== entry ||
      (!options.dependencies && getActiveServerUrl() !== serverUrl)
    )
      throw new Error("The guest listener start was retired.");
  };
  entry.opening = (async () => {
    try {
      if (current) await retire(current, false);
      active();
      const configuration = await dependencies.configuration(tunnelId);
      configuration.dataProtection.key = ""; // This control channel carries no TCP payload.
      active();
      if (
        configuration.source.kind !== "worker-os-listener" ||
        configuration.destination.kind !== "worker-tcp" ||
        configuration.source.workerId !== configuration.workerId
      )
        throw new Error(
          "This saved route no longer listens in CantripOS. Refresh its configuration.",
        );
      entry.summary.workerId = configuration.workerId;
      entry.summary.guestPort = configuration.source.port;
      // A fresh client identity owns a fresh attachment, so late cleanup cannot
      // revoke the replacement started in this or another browser tab.
      const attachment = await dependencies.create(tunnelId, {
        clientId: crypto.randomUUID(),
        kind: "worker-listener",
        expectedRevision: configuration.revision,
      });
      entry.summary.attachmentId = attachment.attachmentId;
      active();
      const connection = await dependencies.open({
        attachmentId: attachment.attachmentId,
        workerId: configuration.workerId,
        onFrame: () => {
          throw new Error(
            "Guest listener control received an unexpected data frame.",
          );
        },
        onClose: (code) => {
          if (entry.closed) return;
          entry.summary.error =
            code === "normal" ? null : `Guest listener disconnected (${code}).`;
          void retire(entry, code !== "normal").catch((error) => {
            entry.summary.status = "failed";
            entry.summary.error =
              error instanceof Error
                ? error.message
                : "Guest listener cleanup is unconfirmed.";
            publish();
          });
        },
        onRouteChanged: (route) => {
          entry.summary.route = route;
          publish();
        },
      });
      entry.connection = connection;
      active();
      entry.summary.route = connection.route;
      entry.summary.status = "active";
      connection.activate();
      active();
      entry.heartbeat = setInterval(() => {
        connection.keepAlive?.();
      }, 20_000);
      publish();
      return { ...entry.summary };
    } catch (error) {
      entry.summary.error =
        error instanceof Error
          ? error.message
          : "The guest listener could not start.";
      await retire(entry, !entry.cancelled).catch(() => {});
      throw error;
    }
  })();
  return entry.opening;
}

export async function stopOsReverseTunnel(
  tunnelId: string,
  serverUrl = getActiveServerUrl(),
) {
  if (!serverUrl) return;
  const entry = runtime.entries.get(key(serverUrl, tunnelId));
  if (!entry) return;
  entry.cancelled = true;
  entry.connection?.close();
  if (entry.opening) await entry.opening.catch(() => {});
  try {
    await retire(entry, false);
  } catch (error) {
    entry.summary.status = "failed";
    entry.summary.error =
      error instanceof Error
        ? error.message
        : "Guest listener cleanup is unconfirmed.";
    publish();
    throw error;
  }
  if (runtime.entries.get(key(serverUrl, tunnelId)) === entry)
    runtime.entries.delete(key(serverUrl, tunnelId));
  publish();
}
