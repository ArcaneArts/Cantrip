import { invoke, isTauri } from "@tauri-apps/api/core";
import { serverBootstrapSchema, type ServerBootstrap } from "@cantrip/protocol";

export type ServerConnection = {
  id: string;
  kind: "local" | "remote";
  name: string;
  url: string;
};

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
    const remotes = parsed.connections.filter(
      (item): item is ServerConnection =>
        item?.kind === "remote" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.url === "string",
    );
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
    localUrl = await invoke<string>("local_server_url");
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
  const response = await fetch(`${url}/api/bootstrap`, {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
  return serverBootstrapSchema.parse(await response.json());
}
