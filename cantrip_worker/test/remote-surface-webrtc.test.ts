import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceWebRtcConfiguration,
  type RemoteSurfaceWebRtcSignal,
} from "@cantrip/protocol";
import { RTCPeerConnection } from "werift";
import { describe, expect, it, vi } from "vitest";

import { WorkerWebRtcAttachment } from "../src/remote-surfaces/webrtc.js";

const encoder = new TextEncoder();

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for WebRTC.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("worker Remote Surface WebRTC transport", () => {
  it("negotiates real local data channels and carries binary envelopes", async () => {
    const client = new RTCPeerConnection({ iceTransportPolicy: "all" });
    const visual = client.createDataChannel("cantrip-visual-v1", {
      ordered: false,
      maxRetransmits: 0,
    });
    const control = client.createDataChannel("cantrip-control-v1", {
      ordered: true,
    });
    const inbound = vi.fn();
    let workerSignalChain = Promise.resolve();
    const attachment = new WorkerWebRtcAttachment({
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      configuration: {
        iceServers: [],
        iceTransportPolicy: "all",
        negotiationTimeoutMs: 8_000,
      },
      emitSignal(signal) {
        workerSignalChain = workerSignalChain.then(async () => {
          if (signal.type === "answer") {
            await client.setRemoteDescription({
              type: "answer",
              sdp: signal.sdp,
            });
          } else if (signal.type === "candidate") {
            await client.addIceCandidate(signal);
          } else if (signal.type === "end-of-candidates") {
            await client.addIceCandidate(null);
          }
        });
      },
      onFrame: inbound,
    });
    let clientSignalChain = Promise.resolve();
    client.onIceCandidate.subscribe((candidate) => {
      const signal: RemoteSurfaceWebRtcSignal = candidate
        ? {
            type: "candidate",
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            usernameFragment: candidate.usernameFragment ?? null,
          }
        : { type: "end-of-candidates" };
      clientSignalChain = clientSignalChain.then(() =>
        attachment.handleSignal(encoder.encode(JSON.stringify(signal))),
      );
    });

    try {
      const offer = await client.createOffer();
      const local = await client.setLocalDescription(offer);
      await attachment.handleSignal(
        encoder.encode(
          JSON.stringify({ type: "offer", sdp: local.toSdp().sdp }),
        ),
      );
      await Promise.all([workerSignalChain, clientSignalChain]);
      await waitFor(
        () =>
          attachment.connected &&
          control.readyState === "open" &&
          visual.readyState === "open",
      );

      control.send(
        Buffer.from(
          encodeRemoteSurfaceFrame(
            {
              protocolVersion: 1,
              surfaceId: "surface-1",
              attachmentId: "attachment-1",
              sequence: 4,
              channel: "control",
            },
            new Uint8Array([1, 2, 3]),
          ),
        ),
      );
      await waitFor(() => inbound.mock.calls.length === 1);
      expect(inbound).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "control", sequence: 4 }),
        new Uint8Array([1, 2, 3]),
      );

      const received = new Promise<ReturnType<typeof decodeRemoteSurfaceFrame>>(
        (resolve) => {
          visual.onMessage.once((message) =>
            resolve(
              decodeRemoteSurfaceFrame(
                typeof message === "string"
                  ? encoder.encode(message)
                  : new Uint8Array(message),
              ),
            ),
          );
        },
      );
      expect(
        attachment.send(
          "frame",
          encodeRemoteSurfaceFrame(
            {
              protocolVersion: 1,
              surfaceId: "surface-1",
              attachmentId: "attachment-1",
              sequence: 9,
              channel: "frame",
            },
            new Uint8Array([9, 8, 7]),
          ),
        ),
      ).toBe("sent");
      await expect(received).resolves.toMatchObject({
        header: { channel: "frame", sequence: 9 },
        payload: new Uint8Array([9, 8, 7]),
      });
    } finally {
      await attachment.close(false);
      await client.close();
    }
  }, 20_000);
});
