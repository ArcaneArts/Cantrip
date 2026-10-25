import { clearSensitiveBytes } from "@cantrip/crypto";
import {
  encryptedPayloadEnvelopeSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";
import {
  clientEncryption,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  decryptWorkspaceTransfer,
  encryptWorkspaceTransfer,
  type WorkspaceTransferBinding,
} from "./workspace-transfer-encryption";

type Kind = WorkspaceTransferBinding["purpose"];
type Packet = { kind: Kind; envelope: EncryptedPayloadEnvelope };
type Port = Pick<
  BroadcastChannel,
  "postMessage" | "addEventListener" | "removeEventListener" | "close"
>;
type Options = {
  binding: Omit<WorkspaceTransferBinding, "purpose">;
  service?: ClientEncryptionService;
  port?: Port;
  onError(error: unknown): void;
} & (
  | {
      side: "source";
      onReady(): void;
      onRestored(): void;
    }
  | {
      side: "destination";
      /** Validate and stage state without activating a second live renderer. */
      restore(bytes: Uint8Array): Promise<void>;
    }
);

/** Ephemeral encrypted transport, not ownership authority. The coordinator must
 * still commit through the server and retire source renderers before activation. */
export function createWorkspaceTransferChannel(options: Options) {
  const binding = { ...options.binding };
  const service = options.service ?? clientEncryption;
  const encryptionIdentity = service.getSnapshot();
  const port =
    options.port ??
    new BroadcastChannel(
      `cantrip-workspace-transfer:${JSON.stringify([
        binding.serverId,
        binding.ownerId,
        binding.workspaceId,
        binding.transferId,
      ])}`,
    );
  let disposed = false;
  let ready = false;
  let restored = false;
  let rejected = false;
  let outgoing: EncryptedPayloadEnvelope | undefined;
  let sending = false;
  let acceptedNonce: string | undefined;
  let rejectedNonce: string | undefined;
  let incoming = Promise.resolve();
  let unsubscribe = () => {};
  const assertLive = () => {
    if (disposed || service.getSnapshot() !== encryptionIdentity)
      throw new Error(
        "Workspace transfer channel is closed or its account changed.",
      );
  };
  const report = (error: unknown) => {
    if (!disposed) options.onError(error);
  };
  const post = (packet: Packet) => {
    assertLive();
    port.postMessage(packet);
  };
  const send = async (kind: Kind, bytes: Uint8Array) => {
    assertLive();
    const envelope = await encryptWorkspaceTransfer(
      { ...binding, purpose: kind },
      bytes,
      service,
    );
    post({ kind, envelope });
  };
  const receivePacket = async (value: unknown) => {
    assertLive();
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      !("envelope" in value)
    )
      return;
    const kind = value.kind;
    if (
      kind !== "ready" &&
      kind !== "snapshot" &&
      kind !== "restored" &&
      kind !== "rejected"
    )
      return;
    if ((options.side === "source") === (kind === "snapshot")) return;
    const envelope = encryptedPayloadEnvelopeSchema.parse(value.envelope);
    const bytes = await decryptWorkspaceTransfer(
      { ...binding, purpose: kind },
      envelope,
      service,
    );
    try {
      assertLive();
      if (options.side === "source") {
        if (kind === "ready") {
          if (bytes.length !== 1 || bytes[0] !== 1)
            throw new Error("Invalid transfer readiness acknowledgement.");
          if (!ready) {
            ready = true;
            options.onReady();
          }
        } else if (
          outgoing &&
          new TextDecoder().decode(bytes) === outgoing.nonce &&
          !restored &&
          !rejected
        ) {
          if (kind === "rejected") {
            rejected = true;
            options.onError(
              new Error("Destination could not restore the transferred views."),
            );
          } else {
            restored = true;
            options.onRestored();
          }
        }
      } else {
        if (!ready)
          throw new Error(
            "Destination application has not announced readiness.",
          );
        if (rejectedNonce) {
          if (rejectedNonce !== envelope.nonce)
            throw new Error(
              "A different snapshot already failed this transfer.",
            );
          await send("rejected", new TextEncoder().encode(rejectedNonce));
          return;
        }
        if (acceptedNonce && acceptedNonce !== envelope.nonce)
          throw new Error(
            "A different snapshot already restored this transfer.",
          );
        if (!acceptedNonce) {
          try {
            await options.restore(bytes);
          } catch (error) {
            // Rejection is bound to this encrypted snapshot, not an arbitrary
            // error packet. Keep private error details in the destination only.
            rejectedNonce = envelope.nonce;
            await send("rejected", new TextEncoder().encode(envelope.nonce));
            throw error;
          }
          assertLive();
          acceptedNonce = envelope.nonce;
        }
        await send("restored", new TextEncoder().encode(envelope.nonce));
      }
    } finally {
      clearSensitiveBytes(bytes);
    }
  };
  const receive = (event: MessageEvent<unknown>) => {
    // Serialize restoration so retries cannot concurrently install the same draft.
    incoming = incoming.then(() => receivePacket(event.data)).catch(report);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    port.removeEventListener("message", receive);
    port.close();
    outgoing = undefined;
  };
  port.addEventListener("message", receive);
  unsubscribe = service.subscribe(() => {
    if (service.getSnapshot() !== encryptionIdentity) {
      dispose();
      options.onError(
        new Error("Workspace transfer account encryption changed."),
      );
    }
  });
  return {
    dispose,
    async announceReady() {
      if (options.side !== "destination")
        throw new Error("Only the destination announces readiness.");
      assertLive();
      ready = true;
      await send("ready", new Uint8Array([1]));
    },
    async sendSnapshot(bytes: Uint8Array) {
      if (options.side !== "source")
        throw new Error("Only the source sends a snapshot.");
      assertLive();
      if (!ready)
        throw new Error(
          "Destination application readiness has not been acknowledged.",
        );
      if (sending || outgoing)
        throw new Error(
          "A snapshot is already prepared; resend that snapshot instead.",
        );
      sending = true;
      try {
        outgoing = await encryptWorkspaceTransfer(
          { ...binding, purpose: "snapshot" },
          bytes,
          service,
        );
        post({ kind: "snapshot", envelope: outgoing });
      } finally {
        sending = false;
      }
    },
    resendSnapshot() {
      assertLive();
      if (!outgoing) throw new Error("No snapshot is available to resend.");
      post({ kind: "snapshot", envelope: outgoing });
    },
  };
}
