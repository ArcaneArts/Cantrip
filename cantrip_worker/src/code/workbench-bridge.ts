import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type {
  CodeAgentTurnNotificationResult,
  CodeAgentTurnPreparationResult,
  CodeAppearance,
  CodeDirtyEditor,
  CodeOpenFileResult,
  CodeOpenSettingsResult,
  CodePresentation,
  CodeSaveAllResult,
  CodeWorkbenchState,
} from "@cantrip/protocol";
import {
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationSessionSchema,
  codeOpenSettingsResultSchema,
  codeWorkbenchStateSchema,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer } from "ws";

import { workerLogError, workerLogger } from "../logger.js";

interface BridgeSession {
  appearance: CodeAppearance;
  authoritativeGeneration: number | null;
  dirtyEditors: CodeDirtyEditor[];
  nextGeneration: number;
  pending: Map<string, PendingBridgeRequest>;
  sockets: Map<WebSocket, BridgeSocket>;
  token: string;
  unresolvedDirtyEditors: CodeDirtyEditor[];
  unresolvedDirtyGeneration: number | null;
  workbench: CodeWorkbenchState;
}

interface PendingBridgeRequest {
  abortListener: (() => void) | null;
  authorityBound: boolean;
  reject(error: Error): void;
  resolve(value: unknown): void;
  signal: AbortSignal | null;
  socket: WebSocket;
  socketGeneration: number;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeSocket {
  dirtyEditors: CodeDirtyEditor[];
  generation: number;
  livenessPending: boolean;
  socket: WebSocket;
  workbench: CodeWorkbenchState | null;
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
const DEFAULT_CONTROL_CONNECT_TIMEOUT_MS = 8_000;
const MAX_CONTROL_CONNECT_TIMEOUT_MS = 9_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 3_000;
const MAX_LIVENESS_INTERVAL_MS = 60_000;
const MAX_LIVENESS_TIMEOUT_MS = 5_000;
const OPEN_SETTINGS_REQUEST_TIMEOUT_MS = 15_000;

export interface CodeWorkbenchBridgeOptions {
  controlConnectTimeoutMs?: number;
  livenessIntervalMs?: number;
  livenessTimeoutMs?: number;
  requestTimeoutMs?: number;
  scheduleLiveness?: (
    sweep: () => Promise<void>,
    intervalMs: number,
  ) => () => void;
}

function scheduleLiveness(
  sweep: () => Promise<void>,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    void sweep().catch((error) =>
      workerLogger.rateLimited(
        "code-bridge-liveness-sweep-failed",
        "warn",
        "Cantrip Code bridge liveness sweep failed",
        {
          event: "code.bridge.liveness-sweep-failed",
          subsystem: "code",
          operation: "probe-liveness",
          reasonCode: "sweep-failed",
          status: "degraded",
          error: workerLogError(error),
        },
      ),
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const duration = Number.isFinite(value) ? value! : fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(duration)));
}

function secureTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Cantrip workbench bridge request was aborted.");
}

function waitForAbortableDelay(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function mergeDirtyEditors(
  editorSets: Iterable<readonly CodeDirtyEditor[]>,
): CodeDirtyEditor[] {
  const editors = new Map<string, CodeDirtyEditor>();
  for (const editorSet of editorSets) {
    for (const editor of editorSet) editors.set(editor.uri, editor);
  }
  return [...editors.values()]
    .sort((left, right) => left.uri.localeCompare(right.uri))
    .slice(0, 1_000);
}

function mergeStrings(values: Iterable<readonly string[]>): string[] {
  return [...new Set([...values].flat())].sort().slice(0, 1_000);
}

function mergeFailures(
  values: Iterable<readonly { uri: string; message: string }[]>,
): Array<{ uri: string; message: string }> {
  const failures = new Map<string, { uri: string; message: string }>();
  for (const items of values) {
    for (const item of items) {
      if (!failures.has(item.uri)) failures.set(item.uri, item);
    }
  }
  return [...failures.values()]
    .sort((left, right) => left.uri.localeCompare(right.uri))
    .slice(0, 1_000);
}

export class CodeWorkbenchBridge {
  readonly #controlConnectTimeoutMs: number;
  #disposeLiveness: (() => void) | null = null;
  #http: Server | null = null;
  readonly #livenessIntervalMs: number;
  readonly #livenessTimeoutMs: number;
  #origin: string | null = null;
  readonly #requestTimeoutMs: number;
  readonly #scheduleLiveness: NonNullable<
    CodeWorkbenchBridgeOptions["scheduleLiveness"]
  >;
  #sessions = new Map<string, BridgeSession>();
  #webSockets: WebSocketServer | null = null;

  constructor(options: CodeWorkbenchBridgeOptions = {}) {
    this.#controlConnectTimeoutMs = boundedDuration(
      options.controlConnectTimeoutMs,
      DEFAULT_CONTROL_CONNECT_TIMEOUT_MS,
      10,
      MAX_CONTROL_CONNECT_TIMEOUT_MS,
    );
    this.#livenessIntervalMs = boundedDuration(
      options.livenessIntervalMs,
      DEFAULT_LIVENESS_INTERVAL_MS,
      1_000,
      MAX_LIVENESS_INTERVAL_MS,
    );
    this.#livenessTimeoutMs = boundedDuration(
      options.livenessTimeoutMs,
      DEFAULT_LIVENESS_TIMEOUT_MS,
      10,
      MAX_LIVENESS_TIMEOUT_MS,
    );
    this.#requestTimeoutMs = Math.max(
      10,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#scheduleLiveness = options.scheduleLiveness ?? scheduleLiveness;
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
        this.#attach(sessionId, session, webSocket);
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
    this.#disposeLiveness = this.#scheduleLiveness(
      () => this.#sweepLiveness(),
      this.#livenessIntervalMs,
    );
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
      this.#rejectPending(
        current,
        "Cantrip workbench bridge session was superseded.",
      );
      for (const socket of current.sockets.keys()) {
        socket.close(1000, "Code session superseded");
      }
      current.sockets.clear();
    }
    this.#sessions.set(sessionId, {
      appearance,
      authoritativeGeneration: null,
      dirtyEditors: [],
      nextGeneration: 1,
      pending: new Map(),
      sockets: new Map(),
      token,
      unresolvedDirtyEditors: [],
      unresolvedDirtyGeneration: null,
      workbench: { ...DEFAULT_WORKBENCH_STATE },
    });
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
    for (const socket of session.sockets.keys()) {
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
    const session = this.#sessions.get(sessionId);
    return Boolean(session && this.#authoritativeSocket(session));
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortReason(signal);
      if (this.#sessions.get(sessionId) !== session) {
        throw new Error("Cantrip workbench bridge session was superseded.");
      }
      if (this.#authoritativeSocket(session)) return true;
      await waitForAbortableDelay(50, signal);
    }
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error("Cantrip workbench bridge session was superseded.");
    }
    if (signal?.aborted) throw abortReason(signal);
    return Boolean(this.#authoritativeSocket(session));
  }

  async saveAll(sessionId: string): Promise<CodeSaveAllResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    if (session.dirtyEditors.length === 0) return { saved: [], failed: [] };
    const contributors = this.#dirtyContributors(session);
    if (contributors.length === 0) {
      return {
        saved: [],
        failed: session.dirtyEditors.map(({ uri }) => ({
          uri,
          message:
            "Cantrip workbench bridge cannot resolve this unsaved editor.",
        })),
      };
    }
    const results = await Promise.allSettled(
      contributors.map(async (contributor) => {
        const result = (await this.#requestOnSocket(
          session,
          contributor,
          "saveAll",
          {},
          false,
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
                  typeof item?.uri === "string" &&
                  typeof item.message === "string",
              )
            : [],
        };
      }),
    );
    return {
      saved: mergeStrings(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.saved] : [],
        ),
      ),
      failed: mergeFailures([
        ...results.flatMap((result, index) => {
          if (result.status === "fulfilled") return [result.value.failed];
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : "Cantrip workbench bridge did not save this editor.";
          return [
            contributors[index]!.dirtyEditors.map(({ uri }) => ({
              uri,
              message,
            })),
          ];
        }),
        session.unresolvedDirtyEditors.map(({ uri }) => ({
          uri,
          message:
            "Cantrip workbench bridge disconnected before this unsaved editor was resolved.",
        })),
      ]),
    };
  }

  async openFile(
    sessionId: string,
    relativePath: string,
    expectedWorkspaceRootUri: string,
    signal?: AbortSignal,
  ): Promise<CodeOpenFileResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    const connected =
      Boolean(this.#authoritativeSocket(session)) ||
      (await this.waitUntilConnected(
        sessionId,
        this.#controlConnectTimeoutMs,
        signal,
      ));
    if (!connected) {
      throw new Error("Cantrip workbench bridge is not connected.");
    }
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error("Cantrip workbench bridge session was superseded.");
    }
    const result = (await this.#request(
      session,
      "openFile",
      {
        expectedWorkspaceRootUri,
        path: relativePath,
      },
      this.#requestTimeoutMs,
      signal,
    )) as Partial<CodeOpenFileResult>;
    if (result.relativePath !== relativePath) {
      throw new Error("Cantrip Code opened an unexpected file.");
    }
    return { relativePath };
  }

  async setPresentation(
    sessionId: string,
    presentation: CodePresentation,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    const connected =
      Boolean(this.#authoritativeSocket(session)) ||
      (await this.waitUntilConnected(
        sessionId,
        this.#controlConnectTimeoutMs,
        signal,
      ));
    if (!connected) {
      throw new Error("Cantrip workbench bridge is not connected.");
    }
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error("Cantrip workbench bridge session was superseded.");
    }
    await this.#request(
      session,
      "setPresentation",
      { presentation },
      this.#requestTimeoutMs,
      signal,
    );
  }

  async openSettings(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<CodeOpenSettingsResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Cantrip Code session is not registered.");
    const connected =
      Boolean(this.#authoritativeSocket(session)) ||
      (await this.waitUntilConnected(
        sessionId,
        this.#controlConnectTimeoutMs,
        signal,
      ));
    if (!connected) {
      throw new Error("Cantrip workbench bridge is not connected.");
    }
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error("Cantrip workbench bridge session was superseded.");
    }
    return codeOpenSettingsResultSchema.parse(
      await this.#request(
        session,
        "openSettings",
        {},
        OPEN_SETTINGS_REQUEST_TIMEOUT_MS,
        signal,
      ),
    );
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
    if (!this.connected(sessionId)) {
      await this.waitUntilConnected(sessionId);
    }
    const contributors = this.#dirtyContributors(session);
    if (contributors.length === 0) {
      return codeAgentTurnPreparationSessionSchema.parse({
        sessionId,
        bridgeConnected: this.connected(sessionId),
        allowed: session.dirtyEditors.length === 0,
        policy: null,
        dirtyEditors: session.dirtyEditors,
        saved: [],
        failed: [],
        reason:
          session.dirtyEditors.length === 0
            ? null
            : "Cantrip Code has unsaved editors, but its workbench bridge is not connected.",
      });
    }
    const results = await Promise.allSettled(
      contributors.map(async (contributor) => {
        const result = (await this.#requestOnSocket(
          session,
          contributor,
          "prepareAgentTurn",
          {},
          false,
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
      }),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : "Cantrip workbench bridge did not prepare this editor.";
      return contributors[index]!.dirtyEditors.map(({ uri }) => ({
        uri,
        message,
      }));
    });
    const unresolvedDirtyEditors = results.flatMap((result, index) =>
      result.status === "rejected" ? contributors[index]!.dirtyEditors : [],
    );
    const completed = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const reasons = [
      ...new Set(
        [
          ...completed.flatMap((result) =>
            result.reason ? [result.reason] : [],
          ),
          ...(failures.length > 0
            ? ["A Cantrip workbench with unsaved editors did not respond."]
            : []),
          ...(session.unresolvedDirtyEditors.length > 0
            ? [
                "A disconnected Cantrip workbench still has unresolved unsaved editors.",
              ]
            : []),
        ].filter(Boolean),
      ),
    ];
    return codeAgentTurnPreparationSessionSchema.parse({
      sessionId,
      bridgeConnected: this.connected(sessionId),
      allowed:
        failures.length === 0 &&
        session.unresolvedDirtyEditors.length === 0 &&
        completed.every((result) => result.allowed),
      policy: this.#strictestPolicy(completed.map((result) => result.policy)),
      dirtyEditors: mergeDirtyEditors([
        ...completed.map((result) => result.dirtyEditors),
        unresolvedDirtyEditors,
        session.unresolvedDirtyEditors,
      ]),
      saved: mergeStrings(completed.map((result) => result.saved)),
      failed: mergeFailures([
        ...completed.map((result) => result.failed),
        failures,
        session.unresolvedDirtyEditors.map(({ uri }) => ({
          uri,
          message:
            "Cantrip workbench bridge disconnected before this unsaved editor was resolved.",
        })),
      ]),
      reason: reasons.length > 0 ? reasons.join(" ").slice(0, 4_000) : null,
    });
  }

  async setTheme(
    sessionId: string,
    appearance: CodeAppearance,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.appearance = appearance;
    const requests = [...session.sockets.values()]
      .filter(({ socket }) => socket.readyState === WebSocket.OPEN)
      .map((connection) =>
        this.#requestOnSocket(
          session,
          connection,
          "setTheme",
          { appearance },
          false,
          this.#requestTimeoutMs,
          signal,
        ),
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
    this.#disposeLiveness?.();
    this.#disposeLiveness = null;
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

  #attach(sessionId: string, session: BridgeSession, socket: WebSocket): void {
    if (this.#sessions.get(sessionId) !== session) {
      socket.close(1008, "Superseded Code session");
      return;
    }
    const connection: BridgeSocket = {
      dirtyEditors: [],
      generation: session.nextGeneration++,
      livenessPending: false,
      socket,
      workbench: null,
    };
    const previousAuthority = session.authoritativeGeneration;
    session.sockets.set(socket, connection);
    session.authoritativeGeneration = connection.generation;
    session.workbench = { ...DEFAULT_WORKBENCH_STATE };
    if (previousAuthority !== null) {
      this.#rejectSupersededAuthority(session, connection.generation);
    }
    workerLogger.event("info", "Cantrip Code workbench bridge connected", {
      event: "code.bridge.connected",
      subsystem: "code",
      operation: "connect",
      status: "completed",
      sessionId,
      counts: { sockets: session.sockets.size },
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.#onMessage(session, connection, data.toString());
    });
    socket.once("close", (code, reason) => {
      if (session.sockets.get(socket) !== connection) return;
      this.#retainUnresolvedDirtyEditors(session, connection);
      session.sockets.delete(socket);
      if (session.authoritativeGeneration === connection.generation) {
        this.#promoteAuthority(session);
      }
      this.#refreshDirtyEditors(session);
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
    void this.#requestOnSocket(
      session,
      connection,
      "setTheme",
      { appearance: session.appearance },
      false,
    ).catch((error) => {
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

  async #sweepLiveness(): Promise<void> {
    const probes: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      for (const connection of session.sockets.values()) {
        if (
          connection.livenessPending ||
          connection.socket.readyState !== WebSocket.OPEN ||
          session.sockets.get(connection.socket) !== connection
        ) {
          continue;
        }
        connection.livenessPending = true;
        probes.push(
          this.#requestOnSocket(
            session,
            connection,
            "ping",
            {},
            false,
            this.#livenessTimeoutMs,
          )
            .then(
              () => undefined,
              // A matching error response is still proof that the extension
              // event loop is responsive. Silence and send failures already
              // retire this exact socket inside #requestOnSocket.
              () => undefined,
            )
            .finally(() => {
              if (session.sockets.get(connection.socket) === connection) {
                connection.livenessPending = false;
              }
            }),
        );
      }
    }
    await Promise.all(probes);
  }

  #onMessage(
    session: BridgeSession,
    connection: BridgeSocket,
    raw: string,
  ): void {
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
      if (session.sockets.get(connection.socket) !== connection) return;
      connection.dirtyEditors = parseDirtyEditors(message.dirtyEditors);
      this.#refreshDirtyEditors(session);
      const workbench = codeWorkbenchStateSchema.safeParse({
        activeEditor: message.activeEditor ?? null,
        git: message.git ?? null,
        conflicts: message.conflicts ?? [],
        savePolicy: message.savePolicy ?? "always",
        agentStatus: message.agentStatus ?? "idle",
      });
      if (workbench.success) {
        if (
          session.authoritativeGeneration === connection.generation &&
          session.unresolvedDirtyGeneration !== null &&
          connection.generation > session.unresolvedDirtyGeneration
        ) {
          // A fresh state publication from a newer authoritative socket is
          // the only evidence that it replaced the disconnected workbench.
          session.unresolvedDirtyEditors = [];
          session.unresolvedDirtyGeneration = null;
          this.#refreshDirtyEditors(session);
        }
        connection.workbench = workbench.data;
        if (session.authoritativeGeneration === connection.generation) {
          session.workbench = workbench.data;
        }
      }
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (
      !pending ||
      pending.socket !== connection.socket ||
      pending.socketGeneration !== connection.generation ||
      session.sockets.get(connection.socket) !== connection ||
      (pending.authorityBound &&
        session.authoritativeGeneration !== connection.generation)
    ) {
      return;
    }
    const settled = this.#takePending(session, message.id);
    if (!settled) return;
    if (message.ok) settled.resolve(message.result);
    else
      settled.reject(new Error(message.error ?? "Workbench request failed."));
  }

  #request(
    session: BridgeSession,
    method: string,
    params: unknown,
    timeoutMs = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.#sessionId(session) === null) {
      return Promise.reject(
        new Error("Cantrip workbench bridge session was superseded."),
      );
    }
    const connection = this.#authoritativeSocket(session);
    if (!connection) {
      return Promise.reject(
        new Error("Cantrip workbench bridge is not connected."),
      );
    }
    return this.#requestOnSocket(
      session,
      connection,
      method,
      params,
      true,
      timeoutMs,
      signal,
    );
  }

  #requestOnSocket(
    session: BridgeSession,
    connection: BridgeSocket,
    method: string,
    params: unknown,
    authorityBound: boolean,
    timeoutMs = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const { socket } = connection;
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Cantrip workbench bridge is not connected."),
      );
    }
    const sessionId = this.#sessionId(session);
    if (sessionId === null) {
      return Promise.reject(
        new Error("Cantrip workbench bridge session was superseded."),
      );
    }
    const id = randomUUID();
    const request: BridgeRequest = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#takePending(session, id);
        if (!pending) return;
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
          sessionId,
        });
        pending.reject(error);
        this.#retireSocket(session, socket, error.message);
      }, timeoutMs);
      const abortListener = signal
        ? () => {
            const pending = this.#takePending(session, id);
            if (!pending) return;
            pending.reject(abortReason(signal));
          }
        : null;
      session.pending.set(id, {
        abortListener,
        authorityBound,
        resolve,
        reject,
        signal: signal ?? null,
        socket,
        socketGeneration: connection.generation,
        timer,
      });
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      socket.send(JSON.stringify(request), (error) => {
        if (!error) return;
        const pending = this.#takePending(session, id);
        if (!pending) return;
        workerLogger.event("warn", "Cantrip Code bridge request send failed", {
          event: "code.bridge.request-send-failed",
          subsystem: "code",
          operation: method,
          reasonCode: "send-failed",
          status: "failed",
          error: workerLogError(error),
          method,
          sessionId,
        });
        pending.reject(error);
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
    const connection = session.sockets.get(socket);
    if (connection) this.#retainUnresolvedDirtyEditors(session, connection);
    session.sockets.delete(socket);
    if (
      connection &&
      session.authoritativeGeneration === connection.generation
    ) {
      this.#promoteAuthority(session);
    }
    this.#refreshDirtyEditors(session);
    this.#rejectPending(session, message, socket);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  #rejectPending(
    session: BridgeSession,
    message: string,
    socket?: WebSocket,
  ): void {
    for (const [id, pending] of [...session.pending]) {
      if (socket && pending.socket !== socket) continue;
      const rejected = this.#takePending(session, id);
      rejected?.reject(new Error(message));
    }
  }

  #takePending(
    session: BridgeSession,
    id: string,
  ): PendingBridgeRequest | null {
    const pending = session.pending.get(id);
    if (!pending) return null;
    session.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  #sessionId(target: BridgeSession): string | null {
    for (const [sessionId, session] of this.#sessions) {
      if (session === target) return sessionId;
    }
    return null;
  }

  #authoritativeSocket(session: BridgeSession): BridgeSocket | null {
    const generation = session.authoritativeGeneration;
    if (generation === null) return this.#promoteAuthority(session);
    const connection = [...session.sockets.values()].find(
      (candidate) =>
        candidate.generation === generation &&
        candidate.socket.readyState === WebSocket.OPEN,
    );
    return connection ?? this.#promoteAuthority(session);
  }

  #dirtyContributors(session: BridgeSession): BridgeSocket[] {
    return [...session.sockets.values()]
      .filter(
        ({ dirtyEditors, socket }) =>
          dirtyEditors.length > 0 && socket.readyState === WebSocket.OPEN,
      )
      .sort((left, right) => left.generation - right.generation);
  }

  #promoteAuthority(session: BridgeSession): BridgeSocket | null {
    const connection = [...session.sockets.values()]
      .filter(({ socket }) => socket.readyState === WebSocket.OPEN)
      .sort((left, right) => right.generation - left.generation)[0];
    session.authoritativeGeneration = connection?.generation ?? null;
    session.workbench = connection?.workbench ?? {
      ...DEFAULT_WORKBENCH_STATE,
    };
    return connection ?? null;
  }

  #refreshDirtyEditors(session: BridgeSession): void {
    session.dirtyEditors = mergeDirtyEditors([
      session.unresolvedDirtyEditors,
      ...[...session.sockets.values()]
        .filter(({ socket }) => socket.readyState === WebSocket.OPEN)
        .map((connection) => connection.dirtyEditors),
    ]);
  }

  #retainUnresolvedDirtyEditors(
    session: BridgeSession,
    connection: BridgeSocket,
  ): void {
    if (connection.dirtyEditors.length === 0) return;
    session.unresolvedDirtyEditors = mergeDirtyEditors([
      session.unresolvedDirtyEditors,
      connection.dirtyEditors,
    ]);
    session.unresolvedDirtyGeneration = Math.max(
      session.unresolvedDirtyGeneration ?? 0,
      connection.generation,
    );
  }

  #rejectSupersededAuthority(
    session: BridgeSession,
    authoritativeGeneration: number,
  ): void {
    for (const [id, pending] of [...session.pending]) {
      if (
        !pending.authorityBound ||
        pending.socketGeneration === authoritativeGeneration
      ) {
        continue;
      }
      const superseded = this.#takePending(session, id);
      superseded?.reject(
        new Error("Cantrip workbench bridge request was superseded."),
      );
    }
  }

  #strictestPolicy(
    policies: Array<"always" | "ask" | "never" | null>,
  ): "always" | "ask" | "never" | null {
    if (policies.includes("ask")) return "ask";
    if (policies.includes("always")) return "always";
    if (policies.includes("never")) return "never";
    return null;
  }
}
