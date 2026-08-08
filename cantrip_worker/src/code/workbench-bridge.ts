import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type {
  CodeAppearance,
  CodeDirtyEditor,
  CodeSaveAllResult,
  CodeThemeMode,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer } from "ws";

interface BridgeSession {
  dirtyEditors: CodeDirtyEditor[];
  pending: Map<
    string,
    {
      reject(error: Error): void;
      resolve(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  socket: WebSocket | null;
  token: string;
}

interface BridgeRequest {
  type: "request";
  id: string;
  method: string;
  params: unknown;
}

interface BridgeResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface BridgeState {
  type: "state";
  dirtyEditors: CodeDirtyEditor[];
}

function secureTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseDirtyEditors(value: unknown): CodeDirtyEditor[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is CodeDirtyEditor =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as CodeDirtyEditor).uri === "string" &&
        ((item as CodeDirtyEditor).relativePath === null ||
          typeof (item as CodeDirtyEditor).relativePath === "string") &&
        typeof (item as CodeDirtyEditor).untitled === "boolean" &&
        (item as CodeDirtyEditor).dirty === true,
    )
    .slice(0, 1_000);
}

export class CodeWorkbenchBridge {
  #http: Server | null = null;
  #origin: string | null = null;
  #sessions = new Map<string, BridgeSession>();
  #webSockets: WebSocketServer | null = null;

  async start(): Promise<void> {
    if (this.#http) return;
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        socket.destroy();
        return;
      }
      const match = /^\/sessions\/([^/]+)$/u.exec(url.pathname);
      const sessionId = match?.[1] ? decodeURIComponent(match[1]) : null;
      const session = sessionId ? this.#sessions.get(sessionId) : null;
      const token = url.searchParams.get("token") ?? "";
      if (!sessionId || !session || !secureTokenEqual(session.token, token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#attach(sessionId, webSocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not bind the Cantrip workbench bridge.");
    }
    this.#http = server;
    this.#webSockets = webSockets;
    this.#origin = `ws://127.0.0.1:${address.port}`;
  }

  register(sessionId: string, token: string): string {
    if (!this.#origin)
      throw new Error("Cantrip workbench bridge is not ready.");
    const current = this.#sessions.get(sessionId);
    if (current) {
      current.token = token;
    } else {
      this.#sessions.set(sessionId, {
        dirtyEditors: [],
        pending: new Map(),
        socket: null,
        token,
      });
    }
    const url = new URL(
      `/sessions/${encodeURIComponent(sessionId)}`,
      this.#origin,
    );
    url.searchParams.set("token", token);
    return url.toString();
  }

  unregister(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#rejectPending(session, "Cantrip Code session stopped.");
    session.socket?.close(1000, "Code session stopped");
    this.#sessions.delete(sessionId);
  }

  connected(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.socket?.readyState === WebSocket.OPEN;
  }

  dirtyEditors(sessionId: string): CodeDirtyEditor[] {
    return [...(this.#sessions.get(sessionId)?.dirtyEditors ?? [])];
  }

  async saveAll(sessionId: string): Promise<CodeSaveAllResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    if (session.dirtyEditors.length === 0) return { saved: [], failed: [] };
    if (!this.connected(sessionId)) {
      return {
        saved: [],
        failed: session.dirtyEditors.map(({ uri }) => ({
          uri,
          message: "Cantrip workbench bridge is not connected.",
        })),
      };
    }
    const result = (await this.#request(
      session,
      "saveAll",
      {},
    )) as Partial<CodeSaveAllResult>;
    return {
      saved: Array.isArray(result.saved)
        ? result.saved.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      failed: Array.isArray(result.failed)
        ? result.failed.filter(
            (item): item is { uri: string; message: string } =>
              typeof item?.uri === "string" && typeof item.message === "string",
          )
        : [],
    };
  }

  async setTheme(
    sessionId: string,
    themeMode: CodeThemeMode,
    appearance: CodeAppearance,
  ): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session || !this.connected(sessionId)) return;
    await this.#request(session, "setTheme", { themeMode, appearance });
  }

  async notifyExternalFiles(sessionId: string, paths: string[]): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session || !this.connected(sessionId) || paths.length === 0) return;
    await this.#request(session, "externalFilesChanged", {
      paths: paths.slice(0, 5_000),
    });
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()])
      this.unregister(sessionId);
    this.#webSockets?.close();
    const server = this.#http;
    this.#webSockets = null;
    this.#http = null;
    this.#origin = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  #attach(sessionId: string, socket: WebSocket): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      socket.close(1008, "Unknown Code session");
      return;
    }
    session.socket?.close(1000, "Bridge replaced");
    session.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.#onMessage(session, data.toString());
    });
    socket.once("close", () => {
      if (session.socket === socket) session.socket = null;
      this.#rejectPending(session, "Cantrip workbench bridge disconnected.");
    });
  }

  #onMessage(session: BridgeSession, raw: string): void {
    let message: BridgeResponse | BridgeState;
    try {
      message = JSON.parse(raw) as BridgeResponse | BridgeState;
    } catch {
      return;
    }
    if (message.type === "state") {
      session.dirtyEditors = parseDirtyEditors(message.dirtyEditors);
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(new Error(message.error ?? "Workbench request failed."));
  }

  #request(
    session: BridgeSession,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const socket = session.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Cantrip workbench bridge is not connected."),
      );
    }
    const id = randomUUID();
    const request: BridgeRequest = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Cantrip workbench ${method} request timed out.`));
      }, 5_000);
      session.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(request), (error) => {
        if (!error) return;
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error);
      });
    });
  }

  #rejectPending(session: BridgeSession, message: string): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    session.pending.clear();
  }
}
