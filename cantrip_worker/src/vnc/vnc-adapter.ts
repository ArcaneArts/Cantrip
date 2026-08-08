import net from "node:net";

import {
  remoteVncClientMessageSchema,
  remoteVncProbeResultSchema,
  remoteVncServerMessageSchema,
  type RemoteSurfaceChannel,
  type RemoteSurfaceConfiguration,
  type RemoteVncProbeResult,
} from "@cantrip/protocol";

import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceAttachment,
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
import { RfbSecurityGateway } from "./rfb-security-gateway.js";
import { VncSecretStore } from "./secret-store.js";

type VncConfiguration = Extract<RemoteSurfaceConfiguration, { kind: "vnc" }>;

interface VncAttachmentState {
  gateway: RfbSecurityGateway | null;
  socket: net.Socket | null;
}

const encoder = new TextEncoder();

function connectionMessage(
  host: string,
  port: number,
  error?: unknown,
): string {
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : null;
  return `Could not connect to VNC endpoint ${host}:${port}${code ? ` (${code})` : ""}.`;
}

export async function probeVncEndpoint(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<RemoteVncProbeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: RemoteVncProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(remoteVncProbeResultSchema.parse(result));
    };
    socket.setTimeout(timeoutMs, () =>
      finish({ reachable: false, message: connectionMessage(host, port) }),
    );
    socket.once("connect", () => finish({ reachable: true, message: null }));
    socket.once("error", (error) =>
      finish({
        reachable: false,
        message: connectionMessage(host, port, error),
      }),
    );
  });
}

export class VncRemoteSurfaceAdapter implements RemoteSurfaceAdapter {
  readonly available = true;

  constructor(private readonly secrets: VncSecretStore) {}

  async open(
    command: Parameters<RemoteSurfaceAdapter["open"]>[0],
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1],
  ): Promise<RemoteSurfaceSession> {
    if (command.configuration.kind !== "vnc") {
      throw new Error("VNC adapter received a non-VNC surface.");
    }
    return new VncRemoteSurfaceSession(
      command.configuration,
      emit,
      this.secrets,
    );
  }
}

class VncRemoteSurfaceSession implements RemoteSurfaceSession {
  readonly configuration: VncConfiguration;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, VncAttachmentState>();
  #closed = false;
  #suspended = false;

  constructor(
    configuration: VncConfiguration,
    private readonly emit: (
      attachmentId: string,
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
    ) => void,
    private readonly secrets: VncSecretStore,
  ) {
    this.configuration = configuration;
  }

  attach(attachment: RemoteSurfaceAttachment): void {
    if (this.#closed) throw new Error("VNC Remote Surface is closed.");
    this.#attachments.set(attachment.id, { gateway: null, socket: null });
  }

  detach(attachmentId: string): void {
    const state = this.#attachments.get(attachmentId);
    this.#attachments.delete(attachmentId);
    state?.socket?.destroy();
  }

  async handleFrame(
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): Promise<void> {
    const state = this.#attachments.get(attachmentId);
    if (!state) return;
    if (channel === "rfb") {
      state.gateway?.acceptClient(payload);
      return;
    }
    if (channel !== "control") return;
    const message = remoteVncClientMessageSchema.parse(
      JSON.parse(new TextDecoder().decode(payload)),
    );
    if (message.type === "disconnect") {
      this.disconnect(attachmentId, null);
    } else {
      await this.connect(attachmentId);
    }
  }

  suspend(): void {
    this.#suspended = true;
    for (const attachmentId of this.#attachments.keys()) {
      this.disconnect(attachmentId, "Remote Desktop suspended.");
    }
  }

  resume(): void {
    this.#suspended = false;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of this.#attachments.values()) state.socket?.destroy();
    this.#attachments.clear();
  }

  private async connect(attachmentId: string): Promise<void> {
    const state = this.#attachments.get(attachmentId);
    if (!state || this.#closed || this.#suspended) return;
    state.socket?.destroy();
    state.socket = null;
    state.gateway = null;
    this.sendState(attachmentId, "connecting", null);

    let password: string | null = null;
    try {
      if (this.configuration.secretRef) {
        password = await this.secrets.read(this.configuration.secretRef);
      }
    } catch {
      this.sendState(
        attachmentId,
        "error",
        "The worker could not load this Remote Desktop credential.",
      );
      return;
    }
    if (!this.#attachments.has(attachmentId) || this.#suspended) return;

    const socket = net.createConnection({
      host: this.configuration.host,
      port: this.configuration.port,
    });
    state.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(10_000, () => {
      this.sendState(
        attachmentId,
        "error",
        connectionMessage(this.configuration.host, this.configuration.port),
      );
      socket.destroy();
    });
    const gateway = new RfbSecurityGateway({
      password,
      sendClient: (bytes) => this.emit(attachmentId, "rfb", bytes),
      sendServer: (bytes) => {
        if (socket.destroyed || socket.writableNeedDrain) {
          socket.destroy(new Error("VNC endpoint write buffer is congested."));
          return;
        }
        socket.write(bytes);
      },
      onReady: () => {
        socket.setTimeout(0);
        this.sendState(attachmentId, "connected", null);
      },
      onError: (message) => {
        this.sendState(attachmentId, "error", message);
        socket.destroy();
      },
    });
    state.gateway = gateway;
    socket.on("data", (bytes) =>
      gateway.acceptServer(
        typeof bytes === "string" ? Buffer.from(bytes) : bytes,
      ),
    );
    socket.once("error", (error) => {
      this.sendState(
        attachmentId,
        "error",
        connectionMessage(
          this.configuration.host,
          this.configuration.port,
          error,
        ),
      );
    });
    socket.once("close", () => {
      if (state.socket !== socket) return;
      state.socket = null;
      state.gateway = null;
      if (this.#attachments.has(attachmentId) && !this.#closed) {
        this.sendState(
          attachmentId,
          "disconnected",
          "The VNC endpoint disconnected.",
        );
      }
    });
  }

  private disconnect(attachmentId: string, message: string | null): void {
    const state = this.#attachments.get(attachmentId);
    if (!state) return;
    const socket = state.socket;
    state.socket = null;
    state.gateway = null;
    socket?.destroy();
    this.sendState(attachmentId, "disconnected", message);
  }

  private sendState(
    attachmentId: string,
    status:
      "connecting" | "connected" | "disconnected" | "reconnecting" | "error",
    message: string | null,
  ): void {
    this.emit(
      attachmentId,
      "control",
      encoder.encode(
        JSON.stringify(
          remoteVncServerMessageSchema.parse({
            type: "vnc-state",
            status,
            message,
          }),
        ),
      ),
    );
  }
}
