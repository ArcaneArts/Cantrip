// Chromium negotiates the existing WorkerLink protocol through Core's public API.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import {
  WORKER_LINK_PEER_CONTROL_CHANNEL,
  filterWorkerLinkPeerSdp,
  workerLinkPeerLaneChannelLabel,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkQosLaneSchema,
} from "../../packages/protocol/dist/worker-link.js";

const MESSAGE_LIMIT = 64 * 1024;

export async function connectPeerWorkerLink(call, session) {
  const base = "/api/worker-links/" + session.sessionId + "/peers";
  const { peerSession } = workerLinkPeerSessionDescriptorSchema.parse(
    await call("POST", base, 201, {
      route: "lan",
      routeGeneration: session.routeGeneration,
    }),
  );
  const path = base + "/" + peerSession.peerSessionId;
  const route = Object.fromEntries(
    ["peerSessionId", "sessionId", "route", "routeGeneration"].map((field) => [
      field,
      peerSession[field],
    ]),
  );
  const hello = {
    type: "worker-link-peer-handshake",
    protocolVersion: 1,
    role: "client",
    ...route,
    identity: session.identity,
    challenge: randomBytes(32).toString("base64url"),
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const socket = new EventEmitter();
    await page.exposeFunction("peerFrame", (bytes) => {
      assert.ok(
        bytes.length <= MESSAGE_LIMIT,
        "CWLK frame fits the negotiated SCTP message",
      );
      socket.emit("message", Buffer.from(bytes), true);
    });
    const { sdp, candidates } = await page.evaluate(
      async ({ label, lanes, hello }) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        const control = pc.createDataChannel(label, { ordered: true });
        const data = Object.fromEntries(
          lanes.map(([lane, name]) => [
            lane,
            pc.createDataChannel(
              name,
              lane === "realtime"
                ? { ordered: false, maxRetransmits: 0 }
                : { ordered: true },
            ),
          ]),
        );
        data.stream.binaryType = "arraybuffer";
        data.stream.onmessage = (event) => {
          void window.peerFrame([...new Uint8Array(event.data)]);
        };
        const state = { pc, control, data, handshake: null };
        window.workerLinkPeer = state;
        control.onopen = () => control.send(JSON.stringify(hello));
        control.onmessage = ({ data }) => {
          state.handshake = JSON.parse(data);
        };
        const candidates = [];
        const gathered = new Promise((resolve) => {
          pc.onicecandidate = ({ candidate }) => {
            if (candidate) candidates.push(candidate.toJSON());
            else resolve();
          };
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await Promise.race([
          gathered,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("Chromium ICE gathering timed out")),
              5000,
            );
          }),
        ]);
        return { sdp: offer.sdp, candidates };
      },
      {
        label: WORKER_LINK_PEER_CONTROL_CHANNEL,
        lanes: workerLinkQosLaneSchema.options.map((lane) => [
          lane,
          workerLinkPeerLaneChannelLabel(lane),
        ]),
        hello,
      },
    );
    const allowed = candidates.filter(
      (value) =>
        filterWorkerLinkPeerSdp("a=" + value.candidate, "lan")
          .removedCandidates === 0,
    );
    assert.ok(allowed.length, "Chromium candidates for the LAN fixture");
    assert.match(sdp, /^a=max-message-size:\d+/mu);
    const limitedOffer = sdp.replace(
      /^a=max-message-size:\d+/mu,
      "a=max-message-size:" + MESSAGE_LIMIT,
    );
    await call("POST", path + "/signals", 204, {
      signals: [
        { type: "offer", sdp: limitedOffer },
        ...allowed.map(
          ({ candidate, sdpMid, sdpMLineIndex, usernameFragment }) => ({
            type: "candidate",
            candidate: {
              candidate,
              sdpMid,
              sdpMLineIndex,
              usernameFragment: usernameFragment ?? null,
            },
          }),
        ),
        { type: "end-of-candidates" },
      ].map((signal, signalSequence) => ({
        ...route,
        signalSequence,
        sender: "client",
        signal,
      })),
    });
    let afterSignalSequence = null;
    let afterAdvertisementSequence = null;
    let accepted = false;
    let advertised = 0;
    let connected = false;
    const deadline = Date.now() + 12_000;
    while (!connected) {
      assert.ok(Date.now() < deadline, "Native WorkerLink peer negotiation");
      const mailbox = workerLinkPeerMailboxSchema.parse(
        await call("POST", path + "/mailbox", 200, {
          afterSignalSequence,
          afterAdvertisementSequence,
        }),
      );
      for (const { signal, signalSequence } of mailbox.signals) {
        afterSignalSequence = signalSequence;
        if (signal.type === "answer") {
          assert.equal(accepted, false);
          await page.evaluate(
            (sdp) =>
              window.workerLinkPeer.pc.setRemoteDescription({
                type: "answer",
                sdp,
              }),
            signal.sdp,
          );
          accepted = true;
        }
        if (signal.type === "transport-state") {
          const transport = await page.evaluate(() => {
            const { pc, control } = window.workerLinkPeer;
            return {
              ice: pc.iceConnectionState,
              connection: pc.connectionState,
              control: control.readyState,
            };
          });
          assert.equal(
            signal.state,
            "connected",
            JSON.stringify({ signal, transport, advertised }),
          );
          connected = true;
        }
      }
      for (const advertisement of mailbox.candidateAdvertisements) {
        assert.equal(accepted, true);
        afterAdvertisementSequence = advertisement.advertisementSequence;
        for (const candidate of advertisement.candidates) {
          assert.equal(
            filterWorkerLinkPeerSdp("a=" + candidate.candidate, "lan")
              .removedCandidates,
            0,
          );
          await page.evaluate(
            (candidate) => window.workerLinkPeer.pc.addIceCandidate(candidate),
            candidate,
          );
          advertised += 1;
        }
        if (advertisement.complete)
          await page.evaluate(() =>
            window.workerLinkPeer.pc.addIceCandidate(null),
          );
      }
      if (!connected) await delay(20);
    }
    assert.ok(advertised > 0);
    const handshake = await page.waitForFunction(
      () => {
        const { handshake, data } = window.workerLinkPeer;
        return (
          Object.values(data).every(
            ({ readyState }) => readyState === "open",
          ) && handshake
        );
      },
      null,
      { timeout: 5000 },
    );
    assert.deepEqual(await handshake.jsonValue(), { ...hello, role: "worker" });
    let sending = Promise.resolve();
    socket.readyState = 1;
    socket.send = (bytes) => {
      sending = sending
        .then(() =>
          page.evaluate(
            (values) =>
              window.workerLinkPeer.data.stream.send(Uint8Array.from(values)),
            [...bytes],
          ),
        )
        .catch((error) => socket.emit("error", error));
    };
    return {
      socket,
      path,
      waitClosed: () =>
        page.waitForFunction(
          () => window.workerLinkPeer.control.readyState === "closed",
          null,
          { timeout: 5000 },
        ),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser?.close();
    await call("DELETE", path, 204);
    throw error;
  }
}
