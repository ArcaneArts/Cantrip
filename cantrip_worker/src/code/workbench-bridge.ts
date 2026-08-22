import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type {
  CodeAgentTurnNotificationResult,
  CodeAgentTurnPreparationResult,
  CodeAppearance,
  CodeDirtyEditor,
  CodeOpenFileResult,
  CodeSaveAllResult,
  CodeWorkbenchState,
} from "@cantrip/protocol";
import {
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationSessionSchema,
  codeWorkbenchStateSchema,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer } from "ws";

import { workerLogError, workerLogger } from "../logger.js";

interface BridgeSession {
  appearance: CodeAppearance;
  dirtyEditors: CodeDirtyEditor[];
  pending: Map<
    string,
    {
      reject(error: Error): void;
      resolve(value: unknown): void;
      socket: WebSocket;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  sockets: Set<WebSocket>;
  token: string;
  workbench: CodeWorkbenchState;
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
  activeEditor?: unknown;
  git?: unknown;
  conflicts?: unknown;
  savePolicy?: unknown;
  agentStatus?: unknown;
}

const DEFAULT_WORKBENCH_STATE: CodeWorkbenchState = {
  activeEditor: null,
  git: null,
  conflicts: [],
  savePolicy: "always",
  agentStatus: "idle",
};
const MAX_BRIDGE_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface CodeWorkbenchBridgeOptions {
  requestTimeoutMs?: number;
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
  readonly #requestTimeoutMs: number;
  #sessions = new Map<string, BridgeSession>();
  #webSockets: WebSocketServer | null = null;

  constructor(options: CodeWorkbenchBridgeOptions = {}) {
    this.#requestTimeoutMs = Math.max(
      10,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  async start(): Promise<void> {
    if (this.#http) return;
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BRIDGE_PAYLOAD_BYTES,
    });
    server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch (error) {
        workerLogger.rateLimited(
          "code-bridge-invalid-upgrade",
          "warn",
          "Cantrip Code bridge rejected an invalid upgrade",
          {
            event: "code.bridge.upgrade-rejected",
            subsystem: "code",
            operation: "bridge-upgrade",
            reasonCode: "invalid-request",
            status: "rejected",
            error: workerLogError(error),
          },
        );
        socket.destroy();
        return;
      }
      const match = /^\/sessions\/([^/]+)$/u.exec(url.pathname);
      const sessionId = match?.[1] ? decodeURIComponent(match[1]) : null;
      const session = sessionId ? this.#sessions.get(sessionId) : null;
      const token = url.searchParams.get("token") ?? "";
      if (!sessionId || !session || !secureTokenEqual(session.token, token)) {
        workerLogger.rateLimited(
          `code-bridge-upgrade-rejected:${sessionId ?? "unknown"}`,
          "warn",
          "Cantrip Code bridge rejected an upgrade",
          {
            event: "code.bridge.upgrade-rejected",
            subsystem: "code",
            operation: "bridge-upgrade",
            hasSessionId: Boolean(sessionId),
            hasToken: Boolean(token),
            reasonCode: !sessionId
              ? "invalid-session-path"
              : !session
                ? "unknown-session"
                : "invalid-token",
            status: "rejected",
            sessionId,
          },
        );
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
    workerLogger.event("info", "Cantrip Code workbench bridge is listening", {
      event: "code.bridge.listening",
      subsystem: "code",
      operation: "start-bridge",
      status: "completed",
    });
  }

  register(
    sessionId: string,
    token: string,
    appearance: CodeAppearance = "dark",
  ): string {
    if (!this.#origin)
      throw new Error("Cantrip workbench bridge is not ready.");
    const current = this.#sessions.get(sessionId);
    if (current) {
      current.token = token;
      current.appearance = appearance;
    } else {
      this.#sessions.set(sessionId, {
        appearance,
        dirtyEditors: [],
        pending: new Map(),
        sockets: new Set(),
        token,
        workbench: { ...DEFAULT_WORKBENCH_STATE },
      });
    }
    const url = new URL(
      `/sessions/${encodeURIComponent(sessionId)}`,
      this.#origin,
    );
    url.searchParams.set("token", token);
    workerLogger.event("debug", "Cantrip Code bridge session registered", {
      event: "code.bridge.session-registered",
      subsystem: "code",
      operation: "register-session",
      status: "completed",
      appearance,
      replaced: Boolean(current),
      sessionId,
    });
    return url.toString();
  }

  unregister(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#rejectPending(session, "Cantrip Code session stopped.");
    for (const socket of session.sockets) {
      socket.close(1000, "Code session stopped");
    }
    session.sockets.clear();
    this.#sessions.delete(sessionId);
    workerLogger.event("debug", "Cantrip Code bridge session unregistered", {
      event: "code.bridge.session-unregistered",
      subsystem: "code",
      operation: "unregister-session",
      status: "completed",
      sessionId,
    });
  }

  connected(sessionId: string): boolean {
    return [...(this.#sessions.get(sessionId)?.sockets ?? [])].some(
      (socket) => socket.readyState === WebSocket.OPEN,
    );
  }

  dirtyEditors(sessionId: string): CodeDirtyEditor[] {
    return [...(this.#sessions.get(sessionId)?.dirtyEditors ?? [])];
  }

  state(sessionId: string): CodeWorkbenchState {
    const state = this.#sessions.get(sessionId)?.workbench;
    return state
      ? {
          ...state,
          conflicts: [...state.conflicts],
          activeEditor: state.activeEditor
            ? {
                ...state.activeEditor,
                selection: { ...state.activeEditor.selection },
              }
            : null,
          git: state.git ? { ...state.git } : null,
        }
      : { ...DEFAULT_WORKBENCH_STATE };
  }

  async waitUntilConnected(
    sessionId: string,
    timeoutMs = 3_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected(sessionId)) return true;
      if (!this.#sessions.has(sessionId)) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.connected(sessionId);
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

  async openFile(
    sessionId: string,
    relativePath: string,
  ): Promise<CodeOpenFileResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    const connected =
      this.connected(sessionId) ||
      (await this.waitUntilConnected(sessionId, 30_000));
    if (!connected) {
      throw new Error("Cantrip workbench bridge is not connected.");
    }
    const result = (await this.#request(session, "openFile", {
      path: relativePath,
    })) as Partial<CodeOpenFileResult>;
    if (result.relativePath !== relativePath) {
      throw new Error("Cantrip Code opened an unexpected file.");
    }
    return { relativePath };
  }

  async prepareAgentTurn(
    sessionId: string,
  ): Promise<CodeAgentTurnPreparationResult["sessions"][number]> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    if (!this.connected(sessionId) && session.dirtyEditors.length === 0) {
      return codeAgentTurnPreparationSessionSchema.parse({
        sessionId,
        bridgeConnected: false,
        allowed: true,
        policy: null,
        dirtyEditors: [],
        saved: [],
        failed: [],
        reason: null,
      });
    }
    const connected =
      this.connected(sessionId) || (await this.waitUntilConnected(sessionId));
    if (!connected) {
      return codeAgentTurnPreparationSessionSchema.parse({
        sessionId,
        bridgeConnected: false,
        allowed: false,
        policy: null,
        dirtyEditors: session.dirtyEditors,
        saved: [],
        failed: [],
        reason:
          "Cantrip Code has unsaved editors, but its workbench bridge is not connected.",
      });
    }
    const result = (await this.#request(
      session,
      "prepareAgentTurn",
      {},
    )) as Record<string, unknown>;
    return codeAgentTurnPreparationSessionSchema.parse({
      sessionId,
      bridgeConnected: true,
      allowed: result.allowed,
      policy: result.policy,
      dirtyEditors: result.dirtyEditors,
      saved: result.saved,
      failed: result.failed,
      reason: result.reason,
    });
  }

  async setTheme(sessionId: string, appearance: CodeAppearance): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.appearance = appearance;
    const requests = [...session.sockets]
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) =>
        this.#requestOnSocket(session, socket, "setTheme", { appearance }),
      );
    if (requests.length === 0) {
      workerLogger.event(
        "debug",
        "Cantrip Code theme saved pending bridge connection",
        {
          event: "code.bridge.theme-deferred",
          subsystem: "code",
          operation: "set-theme",
          status: "deferred",
          appearance,
          sessionId,
        },
      );
      return;
    }
    // The workspace file is the durable theme source. A workbench socket can
    // remain OPEN after its extension host has stopped responding, so theme
    // delivery must converge when a healthy surface reconnects rather than
    // making Code availability depend on an acknowledgement from every view.
    const results = await Promise.allSettled(requests);
    const rejected = results.filter((result) => result.status === "rejected");
    workerLogger.event(
      "debug",
      "Cantrip Code theme delivered to workbench bridge",
      {
        event: "code.bridge.theme-delivered",
        subsystem: "code",
        operation: "set-theme",
        status: rejected.length === 0 ? "completed" : "degraded",
        appearance,
        sessionId,
        counts: { failedSockets: rejected.length, sockets: results.length },
      },
    );
  }

  async notifyExternalFiles(
    sessionId: string,
    paths: string[],
  ): Promise<CodeAgentTurnNotificationResult> {
    const session = this.#sessions.get(sessionId);
    if (!session || !this.connected(sessionId) || paths.length === 0) {
      return codeAgentTurnNotificationResultSchema.parse({
        notifiedSessions: 0,
        refreshed: [],
        conflicts: [],
      });
    }
    const result = (await this.#request(session, "externalFilesChanged", {
      paths: paths.slice(0, 5_000),
    })) as Record<string, unknown>;
    return codeAgentTurnNotificationResultSchema.parse({
      notifiedSessions: 1,
      refreshed: result.refreshed,
      conflicts: result.conflicts,
    });
  }

  async notifyAgentTurn(
    sessionId: string,
    phase: "started" | "completed" | "failed",
    paths: string[],
  ): Promise<CodeAgentTurnNotificationResult> {
    const session = this.#sessions.get(sessionId);
    if (!session || !this.connected(sessionId)) {
      return codeAgentTurnNotificationResultSchema.parse({
        notifiedSessions: 0,
        refreshed: [],
        conflicts: [],
      });
    }
    const result = (await this.#request(session, "agentTurnState", {
      phase,
      paths: paths.slice(0, 5_000),
    })) as Record<string, unknown>;
    return codeAgentTurnNotificationResultSchema.parse({
      notifiedSessions: 1,
      refreshed: result.refreshed,
      conflicts: result.conflicts,
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
    session.sockets.add(socket);
    workerLogger.event("info", "Cantrip Code workbench bridge connected", {
      event: "code.bridge.connected",
      subsystem: "code",
      operation: "connect",
      status: "completed",
      sessionId,
      counts: { sockets: session.sockets.size },
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.#onMessage(session, socket, data.toString());
    });
    socket.once("close", (code, reason) => {
      session.sockets.delete(socket);
      workerLogger.event("warn", "Cantrip Code workbench bridge disconnected", {
        event: "code.bridge.disconnected",
        subsystem: "code",
        operation: "connect",
        reasonCode: code === 1000 ? "normal-close" : "connection-closed",
        status: code === 1000 ? "completed" : "degraded",
        code,
        sessionId,
        counts: { sockets: session.sockets.size },
      });
      this.#rejectPending(
        session,
        "Cantrip workbench bridge disconnected.",
        socket,
      );
    });
    void this.#requestOnSocket(session, socket, "setTheme", {
      appearance: session.appearance,
    }).catch((error) => {
      workerLogger.event(
        "warn",
        "Cantrip Code initial bridge theme request failed",
        {
          event: "code.bridge.theme-delivery-failed",
          subsystem: "code",
          operation: "set-theme",
          reasonCode: "request-failed",
          status: "degraded",
          appearance: session.appearance,
          error: workerLogError(error),
          sessionId,
        },
      );
    });
  }

  #onMessage(session: BridgeSession, socket: WebSocket, raw: string): void {
    let message: BridgeResponse | BridgeState;
    try {
      message = JSON.parse(raw) as BridgeResponse | BridgeState;
    } catch (error) {
      workerLogger.rateLimited(
        "code-bridge-invalid-message",
        "warn",
        "Cantrip Code bridge received an invalid message",
        {
          event: "code.bridge.message-rejected",
          subsystem: "code",
          operation: "receive-message",
          reasonCode: "invalid-json",
          status: "rejected",
          error: workerLogError(error),
        },
      );
      return;
    }
    if (message.type === "state") {
      session.dirtyEditors = parseDirtyEditors(message.dirtyEditors);
      const workbench = codeWorkbenchStateSchema.safeParse({
        activeEditor: message.activeEditor ?? null,
        git: message.git ?? null,
        conflicts: message.conflicts ?? [],
        savePolicy: message.savePolicy ?? "always",
        agentStatus: message.agentStatus ?? "idle",
      });
      if (workbench.success) session.workbench = workbench.data;
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (!pending || pending.socket !== socket) return;
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
    const socket = [...session.sockets]
      .reverse()
      .find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) {
      return Promise.reject(
        new Error("Cantrip workbench bridge is not connected."),
      );
    }
    return this.#requestOnSocket(session, socket, method, params);
  }

  #requestOnSocket(
    session: BridgeSession,
    socket: WebSocket,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Cantrip workbench bridge is not connected."),
      );
    }
    const id = randomUUID();
    const request: BridgeRequest = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        const error = new Error(
          `Cantrip workbench ${method} request timed out.`,
        );
        workerLogger.event("warn", "Cantrip Code bridge request timed out", {
          event: "code.bridge.request-timeout",
          subsystem: "code",
          operation: method,
          reasonCode: "timeout",
          status: "failed",
          method,
          sessionId: this.#sessionId(session),
        });
        reject(error);
        this.#retireSocket(session, socket, error.message);
      }, this.#requestTimeoutMs);
      session.pending.set(id, { resolve, reject, socket, timer });
      socket.send(JSON.stringify(request), (error) => {
        if (!error) return;
        clearTimeout(timer);
        session.pending.delete(id);
        workerLogger.event("warn", "Cantrip Code bridge request send failed", {
          event: "code.bridge.request-send-failed",
          subsystem: "code",
          operation: method,
          reasonCode: "send-failed",
          status: "failed",
          error: workerLogError(error),
          method,
          sessionId: this.#sessionId(session),
        });
        reject(error);
        this.#retireSocket(
          session,
          socket,
          "Cantrip workbench bridge send failed.",
        );
      });
    });
  }

  #retireSocket(
    session: BridgeSession,
    socket: WebSocket,
    message: string,
  ): void {
    session.sockets.delete(socket);
    this.#rejectPending(session, message, socket);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  #rejectPending(
    session: BridgeSession,
    message: string,
    socket?: WebSocket,
  ): void {
    for (const [id, pending] of session.pending) {
      if (socket && pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      session.pending.delete(id);
    }
  }

  #sessionId(target: BridgeSession): string | null {
    for (const [sessionId, session] of this.#sessions) {
      if (session === target) return sessionId;
    }
    return null;
  }
}
