import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { decodeRemoteSurfaceFrame } from "../../packages/protocol/dist/remote-surfaces.js";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  encodeWorkerLinkRemoteSurfaceChunk,
  WorkerLinkRemoteSurfaceFrameAssembler,
} from "../../packages/protocol/dist/worker-link.js";
import { openLocalWorkerLink, openWorkerLinkSocket } from "./direct-client.mjs";

const LANES = ["interactive", "realtime"];

export class RemoteSurfaceWorkerLink {
  static async connect({
    origin,
    call,
    workerId,
    surfaceId,
    viewport,
    route,
    onFrame,
    resourceKind = "browser",
    initialCredit,
  }) {
    let session = await call(
      "POST",
      "/api/workers/" + workerId + "/worker-link/sessions",
      201,
      {
        clientInstanceId: randomUUID(),
      },
    );
    const base = "/api/worker-links/" + session.sessionId;
    let carrier;
    try {
      if (session.preferredRoute !== route) {
        session = await call("POST", base + "/route", 200, {
          preferredRoute: route,
        });
      }
      const grant = await call(
        "POST",
        base + "/remote-surfaces/" + surfaceId + "/grant",
        201,
        { viewport },
      );
      assert.equal(grant.binding.resource.resourceId, surfaceId);
      assert.equal(grant.binding.resource.kind, resourceKind);
      if (route === "lan") {
        const { connectPeerWorkerLink } =
          await import("./worker-link-peer-client.mjs");
        carrier = await connectPeerWorkerLink(
          call,
          session,
          "lan",
          undefined,
          LANES,
        );
      } else {
        assert.equal(session.preferredRoute, route);
        const socket =
          route === "local"
            ? await openLocalWorkerLink(call, session)
            : await openWorkerLinkSocket(origin, call, session);
        carrier = { socket, close: () => socket.terminate() };
        if (socket.readyState === socket.CONNECTING) {
          await once(socket, "open", { signal: AbortSignal.timeout(8000) });
        }
      }
      const link = new RemoteSurfaceWorkerLink(
        carrier,
        session,
        grant,
        call,
        route,
        onFrame,
        initialCredit,
      );
      await link.open();
      return link;
    } catch (error) {
      await carrier?.close();
      await call("DELETE", base, 204);
      throw error;
    }
  }

  constructor(carrier, session, grant, call, route, onFrame, initialCredit) {
    this.carrier = carrier;
    this.session = session;
    this.grant = grant;
    this.call = call;
    this.route = route;
    // LAN has enough credit to exceed its 64 KiB SCTP message limit.
    this.initialCredit = initialCredit ?? (route === "lan" ? 96 : 40) * 1024;
    this.attachment = grant.binding.resource.attachmentId;
    this.lanes = new Map();
    this.frameId = 0;
    this.screenshotChunks = 0;
    this.fragmentedScreenshot = false;
    carrier.socket.on("error", (error) => {
      this.failure ??= error;
    });
    carrier.socket.on("message", (bytes, binary) => {
      try {
        assert.equal(binary, true);
        const { header, payload } = decodeWorkerLinkFrame(bytes);
        const lane = this.lanes.get(header.lane);
        assert.ok(lane);
        assert.deepEqual(header.channel, lane.channel);
        assert.equal(header.sequence, lane.expected++);
        assert.equal(header.effectiveRoute, this.route);
        if (header.kind === "data") {
          assert.equal(header.payloadFormat, "raw");
          assert.equal(header.direction, "worker-to-client");
          assert.ok(payload.byteLength <= this.initialCredit);
          if (header.lane === "realtime") this.screenshotChunks++;
          const assembled = lane.assembler.push(payload);
          if (header.lane === "realtime" && this.deferredCredit !== undefined) {
            this.deferredCredit += payload.byteLength;
          } else {
            this.wire(lane, {
              kind: "credit",
              direction: "worker-to-client",
              bytes: payload.byteLength,
            });
          }
          if (!assembled) return;
          const frame = decodeRemoteSurfaceFrame(assembled);
          assert.equal(frame.header.attachmentId, this.attachment);
          assert.equal(
            frame.header.surfaceId,
            this.grant.binding.resource.resourceId,
          );
          if (header.lane === "realtime") {
            assert.ok(["frame", "cursor"].includes(frame.header.channel));
            if (frame.header.channel === "frame" && this.screenshotChunks > 1) {
              this.fragmentedScreenshot = true;
            }
            this.screenshotChunks = 0;
          } else {
            assert.ok(["control", "clipboard"].includes(frame.header.channel));
          }
          onFrame(frame);
        } else if (header.kind === "credit") {
          assert.equal(header.direction, "client-to-worker");
          lane.credit += header.bytes;
        } else {
          lane.messages.push(header);
        }
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  wire(lane, fields, payload = new Uint8Array()) {
    this.carrier.socket.send(
      encodeWorkerLinkFrame(
        {
          protocolVersion: 1,
          sessionId: this.session.sessionId,
          routeGeneration: this.session.routeGeneration,
          effectiveRoute: this.route,
          channel: lane.channel,
          lane: lane.name,
          sequence: lane.sequence++,
          ...fields,
        },
        payload,
      ),
    );
  }

  async wait(predicate) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (this.failure) throw this.failure;
      assert.ok(
        Date.now() < deadline,
        "Remote Surface WorkerLink message timed out",
      );
      await delay(20);
    }
  }

  async open() {
    for (const name of LANES) {
      const lane = {
        name,
        channel: { channelId: randomUUID(), connectionId: randomUUID() },
        expected: 0,
        sequence: 0,
        messages: [],
        credit: this.initialCredit,
        assembler: new WorkerLinkRemoteSurfaceFrameAssembler(
          name === "realtime",
        ),
      };
      this.lanes.set(name, lane);
      this.wire(lane, {
        kind: "open",
        openNonce: randomUUID(),
        channelKind: "reliable-stream",
        initialCreditBytes: this.initialCredit,
        grant: this.grant,
      });
      await this.wait(() => lane.messages.length > 0);
      const reply = lane.messages.shift();
      assert.equal(reply.kind, "accept", JSON.stringify(reply));
      assert.equal(reply.initialCreditBytes, this.initialCredit);
    }
  }

  async send(frame) {
    const lane = this.lanes.get("interactive");
    const frameId = this.frameId++;
    for (let offset = 0; offset < frame.byteLength; offset += 97) {
      const payload = encodeWorkerLinkRemoteSurfaceChunk({
        frameId,
        offset,
        frameLength: frame.byteLength,
        payload: frame.subarray(offset, offset + 97),
      });
      await this.wait(() => lane.credit >= payload.byteLength);
      lane.credit -= payload.byteLength;
      this.wire(
        lane,
        { kind: "data", direction: "client-to-worker", payloadFormat: "raw" },
        payload,
      );
    }
  }

  terminate() {
    return this.carrier.close();
  }

  async close({ verifyLateCredit = false } = {}) {
    if (verifyLateCredit) {
      assert.equal(this.route, "local");
      this.deferredCredit = 0;
      await this.wait(() => this.deferredCredit > 0);
    }
    const base = "/api/worker-links/" + this.session.sessionId;
    const grant = base + "/grants/" + this.grant.binding.grantId;
    const renewed = await this.call("POST", grant + "/renew", 200);
    assert.equal(
      renewed.absoluteExpiresAt,
      this.grant.binding.lease.absoluteExpiresAt,
    );
    await this.call("DELETE", grant, 204);
    for (const lane of this.lanes.values()) {
      await this.wait(() => lane.messages.length > 0);
      const close = lane.messages.shift();
      assert.equal(close.kind, "close", JSON.stringify(close));
      assert.equal(close.code, "revoked");
    }
    if (verifyLateCredit) {
      this.wire(this.lanes.get("realtime"), {
        kind: "credit",
        direction: "worker-to-client",
        bytes: this.deferredCredit,
      });
      const socket = this.carrier.socket;
      const reply = once(socket, "pong", { signal: AbortSignal.timeout(5000) });
      socket.ping("late-credit");
      assert.equal((await reply)[0].toString(), "late-credit");
    }
    await this.terminate();
    await this.call("DELETE", base, 204);
  }
}
