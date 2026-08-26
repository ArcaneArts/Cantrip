import { invoke } from "@tauri-apps/api/core";
import type {
  TunnelDataProtectionConfiguration,
  WorkerLinkChannelCloseCode,
  WorkerLinkTunnelRoute,
} from "@cantrip/protocol";

import {
  openTunnelWorkerLink,
  type TunnelWorkerLinkConnection,
} from "@/lib/tunnel-worker-link";

const BRIDGE_SEND_HIGH_WATER_BYTES = 8 * 1_024 * 1_024;
const BRIDGE_SEND_TIMEOUT_MS = 10_000;
const BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
const SOCKET_OPEN = 1;
const MIN_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

export interface DesktopTunnelWorkerLinkSummary {
  attachmentId: string;
  diagnosticTraceId: string | null;
  expiresAt: string;
  localHost: "127.0.0.1";
  localPort: number;
  routeState: "local-direct" | "relayed" | "degraded";
  relayFallbackAvailable?: boolean;
  relayCredentialExpiresAtEpochMs?: number | null;
  directCapabilityId: string | null;
  directFallbackReason: string | null;
  lastDestinationRejectionCode?:
    | "congested"
    | "limit-exceeded"
    | "protected-endpoint-unavailable"
    | "protected-record-unavailable"
    | "protected-target-invalid"
    | "protocol-error"
    | "target-rejected"
    | "target-unavailable"
    | "unauthorized"
    | null;
  tunnelId: string;
  bytesFromLocal?: number;
  bytesToLocal?: number;
  connectionsClosed?: number;
  connectionsOpened?: number;
  destinationRejectedCount?: number;
  codePoolGeneration?: string | null;
}

export interface DesktopTunnelWorkerLinkBridge {
  token: string;
  url: string;
}

interface NativeWorkerLinkForwardPreparation {
  bridge: DesktopTunnelWorkerLinkBridge;
  forward: DesktopTunnelWorkerLinkSummary;
}

export interface StartDesktopTunnelWorkerLinkInput {
  attachmentId: string;
  dataProtection: TunnelDataProtectionConfiguration;
  diagnosticTraceId?: string;
  expiresAt: string;
  preferredLocalPort?: number;
  serverUrl: string;
  tunnelId: string;
  workerId: string;
}

type DesktopTunnelWorkerLinkControllerInput = Pick<
  StartDesktopTunnelWorkerLinkInput,
  "attachmentId" | "diagnosticTraceId" | "tunnelId" | "workerId"
>;

interface BridgeSocket {
  binaryType: BinaryType;
  readonly bufferedAmount: number;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: ArrayBuffer | string): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onopen: ((event: Event) => void) | null;
}

export interface DesktopTunnelWorkerLinkDependencies {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  openLink: typeof openTunnelWorkerLink;
  openSocket(url: string): BridgeSocket;
  schedule(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  cancelSchedule(timer: ReturnType<typeof setTimeout>): void;
  now(): number;
}

const defaultDependencies: DesktopTunnelWorkerLinkDependencies = {
  invoke: (command, args) => invoke(command, args),
  openLink: openTunnelWorkerLink,
  openSocket: (url) => new WebSocket(url),
  schedule: setTimeout,
  cancelSchedule: clearTimeout,
  now: Date.now,
};

const activeForwards = new Map<string, DesktopTunnelWorkerLinkController>();

export async function startDesktopTunnelWorkerLinkForward(
  input: StartDesktopTunnelWorkerLinkInput,
  dependencies: DesktopTunnelWorkerLinkDependencies = defaultDependencies,
): Promise<DesktopTunnelWorkerLinkSummary> {
  await stopDesktopTunnelWorkerLinkForward(input.tunnelId);
  const preparation = (await dependencies.invoke(
    "prepare_worker_link_tunnel_forward",
    {
      request: {
        attachmentId: input.attachmentId,
        dataProtection: input.dataProtection,
        diagnosticTraceId: input.diagnosticTraceId ?? null,
        expiresAt: input.expiresAt,
        preferredLocalPort: input.preferredLocalPort ?? null,
        serverUrl: input.serverUrl,
        tunnelId: input.tunnelId,
        workerId: input.workerId,
      },
    },
  )) as NativeWorkerLinkForwardPreparation;
  const controller = new DesktopTunnelWorkerLinkController(
    input,
    preparation.bridge,
    dependencies,
  );
  activeForwards.set(input.tunnelId, controller);
  try {
    const route = await controller.start();
    return {
      ...preparation.forward,
      routeState: routeState(route),
    };
  } catch (error) {
    if (activeForwards.get(input.tunnelId) === controller) {
      activeForwards.delete(input.tunnelId);
    }
    controller.stop();
    await dependencies
      .invoke("stop_tunnel_forward", {
        expectedAttachmentId: input.attachmentId,
        expectedDiagnosticTraceId: input.diagnosticTraceId ?? null,
        expectedDirectCapabilityId: null,
        tunnelId: input.tunnelId,
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function attachDesktopTunnelWorkerLinkForward(
  input: Pick<
    StartDesktopTunnelWorkerLinkInput,
    "attachmentId" | "diagnosticTraceId" | "tunnelId" | "workerId"
  >,
  bridge: DesktopTunnelWorkerLinkBridge,
  dependencies: DesktopTunnelWorkerLinkDependencies = defaultDependencies,
): Promise<"local" | "relay"> {
  await stopDesktopTunnelWorkerLinkForward(input.tunnelId);
  const controller = new DesktopTunnelWorkerLinkController(
    input,
    bridge,
    dependencies,
  );
  activeForwards.set(input.tunnelId, controller);
  try {
    return await controller.start();
  } catch (error) {
    if (activeForwards.get(input.tunnelId) === controller) {
      activeForwards.delete(input.tunnelId);
    }
    controller.stop();
    throw error;
  }
}

export async function stopDesktopTunnelWorkerLinkForward(
  tunnelId: string,
): Promise<void> {
  const controller = activeForwards.get(tunnelId);
  if (!controller) return;
  activeForwards.delete(tunnelId);
  controller.stop();
}

export async function refreshDesktopTunnelWorkerLinkForward(
  tunnelId: string,
  attachmentId: string,
  expiresAt: string,
  dependencies: Pick<
    DesktopTunnelWorkerLinkDependencies,
    "invoke"
  > = defaultDependencies,
): Promise<boolean> {
  return Boolean(
    await dependencies.invoke("refresh_worker_link_tunnel_forward", {
      attachmentId,
      expiresAt,
      tunnelId,
    }),
  );
}

class DesktopTunnelWorkerLinkController {
  #connection: TunnelWorkerLinkConnection | null = null;
  #generation = 0;
  #reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: BridgeSocket | null = null;
  #stopped = false;

  constructor(
    private readonly input: DesktopTunnelWorkerLinkControllerInput,
    private readonly bridge: DesktopTunnelWorkerLinkBridge,
    private readonly dependencies: DesktopTunnelWorkerLinkDependencies,
  ) {}

  async start(): Promise<"local" | "relay"> {
    const route = await this.#connect();
    await this.#publishRoute(this.#generation, route);
    return route;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    if (this.#reconnectTimer) {
      this.dependencies.cancelSchedule(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    const connection = this.#connection;
    this.#socket = null;
    this.#connection = null;
    socket?.close(1000, "Tunnel stopped");
    connection?.close("normal");
    this.bridge.token = "";
  }

  async #connect(): Promise<"local" | "relay"> {
    if (this.#stopped) throw new Error("The desktop tunnel was stopped.");
    const generation = ++this.#generation;
    let connection: TunnelWorkerLinkConnection | null = null;
    let socket: BridgeSocket | null = null;
    try {
      connection = await this.dependencies.openLink({
        attachmentId: this.input.attachmentId,
        ...(this.input.diagnosticTraceId
          ? { diagnosticTraceId: this.input.diagnosticTraceId }
          : {}),
        onClose: (code) => this.#disconnected(generation, code),
        onFrame: (frame) => this.#sendToNative(generation, frame),
        onRouteChanged: (route) => this.#routeChanged(generation, route),
        workerId: this.input.workerId,
      });
      if (this.#stopped || generation !== this.#generation) {
        connection.close("normal");
        throw new Error("The desktop tunnel changed while connecting.");
      }
      this.#connection = connection;
      socket = await openBridgeSocket(
        this.bridge,
        connection.tunnelRoute,
        connection.route,
        (frame) => {
          if (
            this.#stopped ||
            generation !== this.#generation ||
            !connection?.send(frame)
          ) {
            this.#disconnected(generation, "congested");
          }
        },
        () => this.#disconnected(generation, "endpoint-disconnected"),
        this.dependencies,
      );
      if (this.#stopped || generation !== this.#generation) {
        socket.close(1000, "Tunnel changed");
        connection.close("normal");
        throw new Error("The desktop tunnel changed while connecting.");
      }
      this.#socket = socket;
      this.#reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
      connection.activate();
      return connection.route;
    } catch (error) {
      if (this.#socket === socket) this.#socket = null;
      if (this.#connection === connection) this.#connection = null;
      socket?.close(1011, "Tunnel connection failed");
      connection?.close("endpoint-disconnected");
      throw error;
    }
  }

  #disconnected(generation: number, code: WorkerLinkChannelCloseCode): void {
    if (this.#stopped || generation !== this.#generation) return;
    this.#generation += 1;
    const socket = this.#socket;
    const connection = this.#connection;
    this.#socket = null;
    this.#connection = null;
    socket?.close(1011, "WorkerLink disconnected");
    connection?.close(code);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      MAX_RECONNECT_DELAY_MS,
    );
    this.#reconnectTimer = this.dependencies.schedule(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #routeChanged(generation: number, route: "local" | "relay"): void {
    if (this.#stopped || generation !== this.#generation) return;
    void this.#publishRoute(generation, route).catch(() => undefined);
  }

  async #publishRoute(
    generation: number,
    route: "local" | "relay",
  ): Promise<void> {
    if (this.#stopped || generation !== this.#generation) return;
    await this.dependencies.invoke("update_worker_link_tunnel_forward_route", {
      attachmentId: this.input.attachmentId,
      route,
      tunnelId: this.input.tunnelId,
    });
  }

  async #sendToNative(generation: number, frame: Uint8Array): Promise<void> {
    const socket = this.#socket;
    if (
      this.#stopped ||
      generation !== this.#generation ||
      !socket ||
      socket.readyState !== SOCKET_OPEN
    ) {
      throw new Error("The native tunnel bridge is unavailable.");
    }
    const deadline = this.dependencies.now() + BRIDGE_SEND_TIMEOUT_MS;
    while (
      socket.bufferedAmount + frame.byteLength >
      BRIDGE_SEND_HIGH_WATER_BYTES
    ) {
      if (
        this.#stopped ||
        generation !== this.#generation ||
        socket.readyState !== SOCKET_OPEN ||
        this.dependencies.now() >= deadline
      ) {
        throw new Error("The native tunnel bridge is congested.");
      }
      await new Promise<void>((resolve) =>
        this.dependencies.schedule(resolve, 10),
      );
    }
    socket.send(new Uint8Array(frame).buffer);
  }
}

async function openBridgeSocket(
  bridge: DesktopTunnelWorkerLinkBridge,
  route: WorkerLinkTunnelRoute,
  effectiveRoute: "local" | "relay",
  onFrame: (frame: Uint8Array) => void,
  onClose: () => void,
  dependencies: DesktopTunnelWorkerLinkDependencies,
): Promise<BridgeSocket> {
  const socket = dependencies.openSocket(bridge.url);
  socket.binaryType = "arraybuffer";
  return new Promise<BridgeSocket>((resolve, reject) => {
    let settled = false;
    const timeout = dependencies.schedule(() => {
      fail(new Error("The native tunnel bridge handshake timed out."));
    }, BRIDGE_HANDSHAKE_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) {
        onClose();
        return;
      }
      settled = true;
      dependencies.cancelSchedule(timeout);
      socket.close(1008, "Bridge handshake failed");
      reject(error);
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "initialize",
          token: bridge.token,
          route: effectiveRoute,
          identity: {
            attachmentId: route.attachmentId,
            destinationEndpointId: route.destinationEndpointId,
            sourceEndpointId: route.sourceEndpointId,
            tunnelId: route.tunnelId,
          },
        }),
      );
    };
    socket.onerror = () =>
      fail(new Error("The native tunnel bridge could not connect."));
    socket.onclose = () => {
      if (!settled) {
        fail(new Error("The native tunnel bridge closed during handshake."));
      } else {
        onClose();
      }
    };
    socket.onmessage = ({ data }) => {
      if (!settled) {
        if (typeof data !== "string" || !bridgeReady(data, route)) {
          fail(
            new Error(
              "The native tunnel bridge returned an invalid handshake.",
            ),
          );
          return;
        }
        settled = true;
        dependencies.cancelSchedule(timeout);
        resolve(socket);
        return;
      }
      if (data instanceof ArrayBuffer) {
        onFrame(new Uint8Array(data));
        return;
      }
      fail(new Error("The native tunnel bridge returned an invalid frame."));
    };
  });
}

function bridgeReady(payload: string, route: WorkerLinkTunnelRoute): boolean {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return (
      value.type === "ready" &&
      value.tunnelId === route.tunnelId &&
      value.attachmentId === route.attachmentId
    );
  } catch {
    return false;
  }
}

function routeState(route: "local" | "relay"): "local-direct" | "relayed" {
  return route === "local" ? "local-direct" : "relayed";
}
