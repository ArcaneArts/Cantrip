import { invoke, isTauri } from "@tauri-apps/api/core";
import { serverBootstrapSchema, type ServerBootstrap } from "@cantrip/protocol";

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
  version: 1;
};

const storageKey = "cantrip.server-connections.v1";
const localId = "local";
let state: StoredServerConnections = {
  activeId: localId,
  connections: [{ id: localId, kind: "local", name: "Local", url: "" }],
  version: 1,
};

export function normalizeServerUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter the server URL.");
  const url = new URL(value);
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
  storage: Storage,
): StoredServerConnections | null {
  try {
    const parsed = JSON.parse(
      storage.getItem(storageKey) ?? "null",
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
      version: 1,
    };
  } catch {
    return null;
  }
}

function persist(): void {
  const remoteOnly: StoredServerConnections = {
    ...state,
    connections: state.connections.filter(
      (connection) => connection.kind === "remote",
    ),
  };
  window.localStorage.setItem(storageKey, JSON.stringify(remoteOnly));
}

export async function initializeServerConnections(): Promise<void> {
  const stored = readStoredConnections(window.localStorage);
  let localUrl = (import.meta.env.VITE_CANTRIP_SERVER_URL ?? "").replace(
    /\/$/,
    "",
  );
  if (isTauri()) {
    try {
      localUrl = await invoke<string>("local_server_url");
    } catch (error) {
      if (!stored?.activeId || stored.activeId === localId) throw error;
      // A previously selected remote server must remain usable even when the
      // optional embedded service is unavailable during desktop startup.
      localUrl = "";
    }
  }
  const connections: ServerConnection[] = [
    { id: localId, kind: "local", name: "Local", url: localUrl },
    ...(stored?.connections ?? []),
  ];
  state = {
    activeId:
      stored?.activeId &&
      connections.some((item) => item.id === stored.activeId)
        ? stored.activeId
        : localId,
    connections,
    version: 1,
  };
}

export function getServerConnections(): readonly ServerConnection[] {
  return state.connections;
}

export function getActiveServerConnection(): ServerConnection {
  return (
    state.connections.find((connection) => connection.id === state.activeId) ??
    state.connections[0]!
  );
}

export function getActiveServerUrl(): string {
  return getActiveServerConnection().url;
}

export function saveServerConnection(input: {
  name: string;
  url: string;
}): ServerConnection {
  const name = input.name.trim();
  if (!name) throw new Error("Enter a server name.");
  const url = normalizeServerUrl(input.url);
  const existing = state.connections.find(
    (connection) => connection.kind === "remote" && connection.url === url,
  );
  const connection: ServerConnection = existing
    ? { ...existing, name }
    : { id: crypto.randomUUID(), kind: "remote", name, url };
  state = {
    ...state,
    connections: existing
      ? state.connections.map((item) =>
          item.id === existing.id ? connection : item,
        )
      : [...state.connections, connection],
  };
  persist();
  return connection;
}

export function selectServerConnection(id: string): void {
  if (!state.connections.some((connection) => connection.id === id)) {
    throw new Error("That server connection no longer exists.");
  }
  state = { ...state, activeId: id };
  persist();
}

export function removeServerConnection(id: string): void {
  if (id === localId)
    throw new Error("The bundled local server cannot be removed.");
  state = {
    ...state,
    activeId: state.activeId === id ? localId : state.activeId,
    connections: state.connections.filter((connection) => connection.id !== id),
  };
  persist();
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
