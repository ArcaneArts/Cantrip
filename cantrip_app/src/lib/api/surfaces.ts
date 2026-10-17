import {
  browserWireListSchema,
  browserServiceListSchema,
  browserServiceFleetDiscoverySchema,
  browserTunnelRequestSchema,
  tunnelWireListSchema,
  browserTunnelWireRequestSchema,
  browserWireSummarySchema,
  remoteDesktopWireListSchema,
  remoteDesktopFleetWireSchema,
  remoteDesktopWireSummarySchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import type {
  BrowserTunnelRequest,
  ExecutionTarget,
  BrowserSummary,
  RemoteDesktopTarget,
  RemoteDesktopSummary,
} from "@cantrip/protocol";
import {
  openTunnelContentRecord,
  protectTunnelContentRecord,
  createTunnelDataProtection,
  openTunnelSummary,
} from "@/lib/tunnel-content-encryption";
import { remoteDesktopRequestError } from "@/lib/remote-desktop-request-error";
import { ensureTunnelWorker } from "./tunnels";

export async function getBrowsers(projectId: string) {
  const browsers = browserWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/browsers`),
  );
  const opened = await Promise.all(
    browsers.map((browser) => surfaceTitleEncryption.openBrowser(browser)),
  );
  for (const browser of opened) {
    browserStateRevisions.set(browser.id, browser.stateRevision);
  }
  return opened;
}

export async function getBrowserServices(browserId: string) {
  return browserServiceListSchema.parse(
    await request(`/api/browsers/${encodeURIComponent(browserId)}/services`),
  );
}

export async function getProjectBrowserServices(projectId: string) {
  return browserServiceFleetDiscoverySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/browser-services`,
    ),
  );
}

export async function ensureBrowserTunnel(
  browserId: string,
  input: { url: string; workerId?: string },
) {
  const url = new URL(input.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Local Browser tunnels require an uncredentialed HTTP or HTTPS URL.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const host =
    hostname === "127.0.0.1" || hostname === "0.0.0.0"
      ? "127.0.0.1"
      : hostname === "localhost"
        ? "localhost"
        : hostname === "::1" || hostname === "[::1]"
          ? "::1"
          : null;
  if (!host) {
    throw new Error(
      "Local Browser tunnels may only target a loopback service on the selected worker.",
    );
  }
  const route: BrowserTunnelRequest = {
    protocol: url.protocol === "https:" ? "https" : "http",
    host,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    ...(input.workerId ? { workerId: input.workerId } : {}),
  };
  const parsed = browserTunnelRequestSchema.parse(route);
  const existing = tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ managedBy }) =>
        managedBy?.kind === "browser" && managedBy.id === browserId,
    );
  const workerId = parsed.workerId ?? existing?.destination.workerId;
  if (!workerId) {
    throw new Error(
      "A destination worker is required for this Browser tunnel.",
    );
  }
  await ensureTunnelWorker(workerId);
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  const destination = {
    kind: "worker-tcp" as const,
    workerId,
    host: parsed.host,
    port: parsed.port,
  };
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: `Browser tunnel · ${url.host}`.slice(0, 120),
      description: "Temporary local access created by the owning Browser tab.",
      source: { kind: "desktop-loopback" },
      destination,
      dataProtection:
        existingContent?.dataProtection ?? createTunnelDataProtection(),
    },
    operationId: crypto.randomUUID(),
    revision: (existing?.protectedRecord?.revision ?? 0) + 1,
    tunnelId,
    workerId,
  });
  return openTunnelSummary(
    await post(
      `/api/browsers/${encodeURIComponent(browserId)}/tunnel`,
      browserTunnelWireRequestSchema.parse({
        tunnelId,
        protocolHint:
          parsed.protocol === "https" ? "https-websocket" : "http-websocket",
        workerId,
        resetAttachments: Boolean(
          existingContent &&
          JSON.stringify(existingContent.destination) !==
            JSON.stringify(destination),
        ),
        protectedRecord,
      }),
    ),
  );
}

export async function createBrowser(
  projectId: string,
  title: string,
  paneId?: string,
  target?: ExecutionTarget,
  url?: string,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "browser",
  );
  const stateProtection = await surfaceTitleEncryption.protectBrowserState(
    id,
    url ?? "https://example.com/",
    1,
  );
  const browser = await surfaceTitleEncryption.openBrowser(
    browserWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/browsers`, {
        id,
        titleProtection,
        stateProtection,
        ...(paneId ? { paneId } : {}),
        ...(target ? { target } : {}),
      }),
    ),
  );
  browserStateRevisions.set(browser.id, browser.stateRevision);
  return browser;
}

const browserStateRevisions = new Map<string, number>();

const browserUpdateChains = new Map<string, Promise<void>>();

export function updateBrowser(
  browserId: string,
  input: { title?: string; url?: string; stateRevision?: number },
) {
  let resolveResult!: (browser: BrowserSummary) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<BrowserSummary>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const previous = browserUpdateChains.get(browserId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const titleProtection = input.title
        ? await surfaceTitleEncryption.protect(
            browserId,
            input.title,
            "browser",
          )
        : undefined;
      const expectedStateRevision =
        browserStateRevisions.get(browserId) ?? input.stateRevision;
      if (input.url && !expectedStateRevision) {
        throw new Error("Browser state revision is unavailable.");
      }
      const stateProtection = input.url
        ? await surfaceTitleEncryption.protectBrowserState(
            browserId,
            input.url,
            expectedStateRevision! + 1,
          )
        : undefined;
      const browser = await surfaceTitleEncryption.openBrowser(
        browserWireSummarySchema.parse(
          await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
            method: "PATCH",
            body: JSON.stringify({
              ...(titleProtection ? { titleProtection } : {}),
              ...(stateProtection
                ? { expectedStateRevision, stateProtection }
                : {}),
            }),
          }),
        ),
      );
      browserStateRevisions.set(browser.id, browser.stateRevision);
      resolveResult(browser);
    })
    .catch(rejectResult)
    .finally(() => {
      if (browserUpdateChains.get(browserId) === next) {
        browserUpdateChains.delete(browserId);
      }
    });
  browserUpdateChains.set(browserId, next);
  return result;
}

export async function deleteBrowser(browserId: string) {
  await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
    method: "DELETE",
  });
  browserStateRevisions.delete(browserId);
  browserUpdateChains.delete(browserId);
}

export async function getRemoteDesktops(projectId: string) {
  const desktops = remoteDesktopWireListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
    ),
  );
  const opened = await Promise.all(
    desktops.map((desktop) =>
      surfaceTitleEncryption.openRemoteDesktop(desktop),
    ),
  );
  for (const desktop of opened) {
    remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  }
  return opened;
}

export async function getRemoteDesktopFleet(projectId: string) {
  const fleet = await surfaceTitleEncryption.openRemoteDesktopFleet(
    remoteDesktopFleetWireSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/remote-desktop-fleet`,
      ),
    ),
  );
  for (const worker of fleet.workers) {
    for (const desktop of worker.desktops) {
      remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
    }
  }
  return fleet;
}

export async function getRemoteDesktop(desktopId: string) {
  let response: unknown;
  try {
    response = await request(
      `/api/remote-desktops/${encodeURIComponent(desktopId)}`,
    );
  } catch (error) {
    throw remoteDesktopRequestError("load", error);
  }
  const desktop = await surfaceTitleEncryption.openRemoteDesktop(
    remoteDesktopWireSummarySchema.parse(response),
  );
  remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  return desktop;
}

const remoteDesktopStateRevisions = new Map<string, number>();

const remoteDesktopUpdateChains = new Map<string, Promise<void>>();

export async function createRemoteDesktop(
  projectId: string,
  paneId?: string,
  target?: ExecutionTarget,
  desktopTarget?: RemoteDesktopTarget,
) {
  const id = crypto.randomUUID();
  const initialTarget = desktopTarget ?? {
    kind: "monitor" as const,
    id: null,
    name: null,
  };
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    "Remote Desktop",
    "project-view",
  );
  const stateProtection =
    await surfaceTitleEncryption.protectRemoteDesktopState(
      id,
      initialTarget,
      1,
    );
  let response: unknown;
  try {
    response = await post(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
      {
        id,
        stateProtection,
        titleProtection,
        ...(paneId ? { paneId } : {}),
        ...(target ? { target } : {}),
      },
    );
  } catch (error) {
    throw remoteDesktopRequestError("create", error);
  }
  const desktop = await surfaceTitleEncryption.openRemoteDesktop(
    remoteDesktopWireSummarySchema.parse(response),
  );
  remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  return desktop;
}

export async function updateRemoteDesktopTarget(
  desktopId: string,
  target: RemoteDesktopTarget,
) {
  let resolveResult!: (desktop: RemoteDesktopSummary) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<RemoteDesktopSummary>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const previous =
    remoteDesktopUpdateChains.get(desktopId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const expectedStateRevision = remoteDesktopStateRevisions.get(desktopId);
      if (!expectedStateRevision) {
        throw new Error("Remote Desktop state revision is unavailable.");
      }
      const stateProtection =
        await surfaceTitleEncryption.protectRemoteDesktopState(
          desktopId,
          target,
          expectedStateRevision + 1,
        );
      const desktop = await surfaceTitleEncryption.openRemoteDesktop(
        remoteDesktopWireSummarySchema.parse(
          await request(
            `/api/remote-desktops/${encodeURIComponent(desktopId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ expectedStateRevision, stateProtection }),
            },
          ),
        ),
      );
      remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
      resolveResult(desktop);
    })
    .catch(rejectResult)
    .finally(() => {
      if (remoteDesktopUpdateChains.get(desktopId) === next) {
        remoteDesktopUpdateChains.delete(desktopId);
      }
    });
  remoteDesktopUpdateChains.set(desktopId, next);
  return result;
}
