import { invoke, isTauri } from "@tauri-apps/api/core";
import { serverBootstrapSchema, type ServerBootstrap } from "@cantrip/protocol";

import {
  readServerConnectionPayloads,
  writeServerConnectionPayload,
} from "@/lib/server-connection-storage";

export type ServerConnection = {
  id: string;
  kind: "local" | "remote";
  name: string;
  url: string;
};

export type ServerConnectionFailureKind =
  "authentication" | "compatibility" | "network" | "tls" | "version";

export class ServerConnectionError extends Error {
  constructor(
    message: string,
    readonly kind: ServerConnectionFailureKind,
  ) {
    super(message);
  }
}

type StoredServerConnections = {
  activeId: string;
  connections: ServerConnection[];
  updatedAt: number;
  version: 1;
};

const localId = "local";
let state: StoredServerConnections = {
  activeId: "",
  connections: [],
  updatedAt: 0,
  version: 1,
};

export function normalizeServerUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter the server URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid server URL, including http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URLs must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials cannot be stored in a server URL.");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(
      "Use the server origin without a path, query, or fragment.",
    );
  }
  return url.origin;
}

function readStoredConnections(
  payload: string,
): StoredServerConnections | null {
  try {
    const parsed = JSON.parse(
      payload,
    ) as Partial<StoredServerConnections> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.connections))
      return null;
    const remotes = parsed.connections.flatMap((item) => {
      if (
        item?.kind !== "remote" ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.url !== "string"
      ) {
        return [];
      }
      try {
        return [
          {
            id: item.id,
            kind: "remote" as const,
            name: item.name.trim() || "Cantrip Server",
            url: normalizeServerUrl(item.url),
          },
        ];
      } catch {
        return [];
      }
    });
    return {
      activeId:
        parsed.activeId === localId ||
        remotes.some((item) => item.id === parsed.activeId)
          ? (parsed.activeId ?? localId)
          : localId,
      connections: remotes,
      updatedAt:
        typeof parsed.updatedAt === "number" &&
        Number.isFinite(parsed.updatedAt) &&
        parsed.updatedAt >= 0
          ? parsed.updatedAt
          : 0,
      version: 1,
    };
  } catch {
    return null;
  }
}

function newestStoredConnections(
  payloads: readonly string[],
): StoredServerConnections | null {
  return (
    payloads
      .map(readStoredConnections)
      .filter((stored): stored is StoredServerConnections => stored !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  );
}

function nextUpdatedAt(): number {
  return Math.max(Date.now(), state.updatedAt + 1);
}

async function refreshServerConnections(): Promise<void> {
  const stored = newestStoredConnections(await readServerConnectionPayloads());
  if (!stored || stored.updatedAt <= state.updatedAt) return;
  const local = state.connections.find(
    (connection) => connection.kind === "local",
  );
  const connections = local
    ? [local, ...stored.connections]
    : [...stored.connections];
  state = {
    ...stored,
    activeId: connections.some(
      (connection) => connection.id === stored.activeId,
    )
      ? stored.activeId
      : (local?.id ?? connections[0]?.id ?? ""),
    connections,
  };
}

async function persist(): Promise<void> {
  const remoteOnly: StoredServerConnections = {
    ...state,
    connections: state.connections.filter(
      (connection) => connection.kind === "remote",
    ),
  };
  await writeServerConnectionPayload(JSON.stringify(remoteOnly));
}

export async function initializeServerConnections(): Promise<void> {
  const stored = newestStoredConnections(await readServerConnectionPayloads());
  const desktopApp = isTauri();
  let localUrl = "";
  if (desktopApp) {
    try {
      localUrl = await invoke<string>("local_server_url");
    } catch (error) {
      if (!stored?.activeId || stored.activeId === localId) throw error;
      // A previously selected remote server must remain usable even when the
      // optional embedded service is unavailable during desktop startup.
      localUrl = "";
    }
  }
  const connections: ServerConnection[] = desktopApp
    ? [
        { id: localId, kind: "local", name: "Local", url: localUrl },
        ...(stored?.connections ?? []),
      ]
    : [...(stored?.connections ?? [])];
  state = {
    activeId:
      stored?.activeId &&
      connections.some((item) => item.id === stored.activeId)
        ? stored.activeId
        : (connections[0]?.id ?? ""),
    connections,
    updatedAt: stored?.updatedAt ?? 0,
    version: 1,
  };
}

export function getServerConnections(): readonly ServerConnection[] {
  return state.connections;
}

export function getActiveServerConnection(): ServerConnection | null {
  return (
    state.connections.find((connection) => connection.id === state.activeId) ??
    state.connections[0] ??
    null
  );
}

export function getActiveServerUrl(): string {
  return getActiveServerConnection()?.url ?? "";
}

export async function saveServerConnection(input: {
  name: string;
  url: string;
}): Promise<ServerConnection> {
  const name = input.name.trim();
  if (!name) throw new Error("Enter a server name.");
  const url = normalizeServerUrl(input.url);
  await refreshServerConnections();
  const existing = state.connections.find(
    (connection) => connection.kind === "remote" && connection.url === url,
  );
  const connection: ServerConnection = existing
    ? { ...existing, name }
    : { id: crypto.randomUUID(), kind: "remote", name, url };
  const previousState = state;
  state = {
    ...state,
    connections: existing
      ? state.connections.map((item) =>
          item.id === existing.id ? connection : item,
        )
      : [...state.connections, connection],
    updatedAt: nextUpdatedAt(),
  };
  try {
    await persist();
  } catch (error) {
    state = previousState;
    throw error;
  }
  return connection;
}

export async function selectServerConnection(id: string): Promise<void> {
  await refreshServerConnections();
  if (!state.connections.some((connection) => connection.id === id)) {
    throw new Error("That server connection no longer exists.");
  }
  const previousState = state;
  state = { ...state, activeId: id, updatedAt: nextUpdatedAt() };
  try {
    await persist();
  } catch (error) {
    state = previousState;
    throw error;
  }
}

export async function removeServerConnection(id: string): Promise<void> {
  if (id === localId)
    throw new Error("The bundled local server cannot be removed.");
  await refreshServerConnections();
  const previousState = state;
  const connections = state.connections.filter(
    (connection) => connection.id !== id,
  );
  const fallbackId =
    connections.find((connection) => connection.kind === "local")?.id ??
    connections[0]?.id ??
    "";
  state = {
    ...state,
    activeId:
      state.activeId === id ||
      !connections.some((connection) => connection.id === state.activeId)
        ? fallbackId
        : state.activeId,
    connections,
    updatedAt: nextUpdatedAt(),
  };
  try {
    await persist();
  } catch (error) {
    state = previousState;
    throw error;
  }
}

export async function testServerConnection(
  input: string,
  timeoutMs = 8_000,
): Promise<ServerBootstrap> {
  const url = normalizeServerUrl(input);
  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    new URL(url).protocol !== "https:"
  ) {
    throw new ServerConnectionError(
      "This secure app cannot connect to an unencrypted HTTP server. Use HTTPS.",
      "tls",
    );
  }
  let response: Response;
  try {
    response = await fetch(`${url}/api/bootstrap`, {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      new URL(url).protocol === "https:" &&
      /certificate|ssl|tls|secure connection/i.test(message)
    ) {
      throw new ServerConnectionError(
        "The server's TLS certificate could not be verified.",
        "tls",
      );
    }
    throw new ServerConnectionError(
      error instanceof DOMException &&
        ["AbortError", "TimeoutError"].includes(error.name)
        ? "The server connection timed out."
        : "The server could not be reached. Check its address and network access.",
      "network",
    );
  }
  if (!response.ok) {
    const kind: ServerConnectionFailureKind =
      response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 404 || response.status === 426
          ? "version"
          : "network";
    const message =
      kind === "authentication"
        ? "The server requires authentication before it can be tested."
        : kind === "version"
          ? "This server does not expose a compatible Cantrip bootstrap endpoint."
          : `The server returned HTTP ${response.status}.`;
    throw new ServerConnectionError(message, kind);
  }
  const payload = await response.json().catch(() => null);
  const parsed = serverBootstrapSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ServerConnectionError(
      "The server responded, but its Cantrip protocol is incompatible with this app.",
      "compatibility",
    );
  }
  return parsed.data;
}
