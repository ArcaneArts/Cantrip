/** Headless QA loopback client using the actual product API and WorkerLink SDK. */
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  tunnelAttachmentCreateResultSchema,
  workerLinkTunnelGrantSchema,
  workerLinkLeaseSchema,
  type TunnelWireSummary,
} from "@cantrip/protocol";
import type { TunnelContentRecord } from "@cantrip/protocol/tunnel-content";
import {
  openTunnelWorkerLink,
  type TunnelWorkerLinkConnection,
} from "./tunnel-worker-link";
import type { productTestContext } from "./os-product-test-support";

export async function productTestForward(
  context: Awaited<ReturnType<typeof productTestContext>>,
  tunnel: TunnelWireSummary,
  content: TunnelContentRecord,
) {
  const { api, manager } = context;
  const protection = await import(
    new URL(
      "../../../cantrip_worker/src/tunnel-data-protection.ts",
      import.meta.url,
    ).href
  );
  const attachment = tunnelAttachmentCreateResultSchema.parse(
    await api(`/api/tunnels/${tunnel.id}/attachments`, {
      clientId: randomUUID(),
    }),
  );
  const clients = new Map<
    string,
    {
      socket: Socket;
      sequence: number;
      credit: number;
      accepted: boolean;
      pending: Buffer;
      ended: boolean;
    }
  >();
  let connection: TunnelWorkerLinkConnection | undefined;
  const frame = (
    id: string,
    header: Record<string, unknown>,
    payload = new Uint8Array(),
  ) => {
    if (!connection) return;
    const route = connection.tunnelRoute;
    const client = clients.get(id);
    const base = {
      protocolVersion: 1,
      tunnelId: route.tunnelId,
      attachmentId: route.attachmentId,
      sourceEndpointId: route.sourceEndpointId,
      destinationEndpointId: route.destinationEndpointId,
      connectionId: id,
    };
    if (
      !connection.send(
        encodeTunnelDataPlaneFrame(
          {
            ...base,
            sequence:
              typeof header.sequence === "number"
                ? header.sequence
                : client
                  ? client.sequence++
                  : 0,
            ...header,
          } as Parameters<typeof encodeTunnelDataPlaneFrame>[0],
          payload,
        ),
      )
    )
      client?.socket.destroy(new Error("Product QA tunnel became congested."));
  };
  const flush = (id: string) => {
    const c = clients.get(id);
    if (!c?.accepted || !connection) return;
    while (c.pending.length && c.credit > 0) {
      const bytes = c.pending.subarray(
        0,
        Math.min(c.pending.length, c.credit, 16_384),
      );
      const route = connection.tunnelRoute;
      const sealed = protection.sealTunnelDataFrame(
        content.dataProtection,
        {
          protocolVersion: 1,
          tunnelId: route.tunnelId,
          attachmentId: route.attachmentId,
          sourceEndpointId: route.sourceEndpointId,
          destinationEndpointId: route.destinationEndpointId,
          connectionId: id,
          sequence: c.sequence++,
          kind: "data",
          direction: "source-to-destination",
        },
        bytes,
      );
      if (
        !connection.send(
          encodeTunnelDataPlaneFrame(sealed.header, sealed.payload),
        )
      ) {
        c.socket.destroy();
        return;
      }
      c.credit -= bytes.length;
      c.pending = c.pending.subarray(bytes.length);
    }
    if (c.pending.length === 0) {
      if (c.ended) {
        c.ended = false;
        frame(id, { kind: "half-close", direction: "source-to-destination" });
      } else c.socket.resume();
    }
  };
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    const id = randomUUID();
    socket.pause();
    socket.on("error", () => {});
    clients.set(id, {
      socket,
      sequence: 1,
      credit: 0,
      accepted: false,
      pending: Buffer.alloc(0),
      ended: false,
    });
    socket.on("data", (bytes) => {
      socket.pause();
      const c = clients.get(id);
      if (c) {
        c.pending = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
        flush(id);
      }
    });
    socket.on("end", () => {
      const c = clients.get(id);
      if (c) {
        c.ended = true;
        flush(id);
      }
    });
    socket.once("close", () => {
      frame(id, { kind: "close", code: "normal" });
      clients.delete(id);
    });
    frame(id, {
      kind: "connect",
      sequence: 0,
      initialCreditBytes: 256 * 1024,
      target: connection!.tunnelRoute.target,
    });
  });
  const close = async () => {
    for (const c of clients.values()) c.socket.destroy();
    clients.clear();
    connection?.close();
    if (listener.listening)
      await new Promise<void>((resolve, reject) =>
        listener.close((e) => (e ? reject(e) : resolve())),
      );
    await api(
      `/api/tunnel-attachments/${attachment.attachmentId}`,
      undefined,
      "DELETE",
    );
  };
  try {
    connection = await openTunnelWorkerLink(
      {
        attachmentId: attachment.attachmentId,
        workerId: tunnel.destination.workerId,
        onClose() {
          for (const c of clients.values()) c.socket.destroy();
        },
        onFrame(bytes) {
          const { header, payload } = decodeTunnelDataPlaneFrame(bytes),
            c = clients.get(header.connectionId);
          if (!c) return;
          if (header.kind === "accepted") {
            c.accepted = true;
            c.credit += header.initialCreditBytes;
            flush(header.connectionId);
          } else if (header.kind === "credit") {
            c.credit += header.bytes;
            flush(header.connectionId);
          } else if (header.kind === "data") {
            const plain = protection.openTunnelDataFrame(
              content.dataProtection,
              header,
              payload,
            );
            c.socket.write(plain, () =>
              frame(header.connectionId, {
                kind: "credit",
                direction: "destination-to-source",
                bytes: plain.length,
              }),
            );
          } else if (header.kind === "half-close" || header.kind === "close")
            c.socket.end();
          else if (header.kind === "error" || header.kind === "rejected")
            c.socket.destroy();
        },
      },
      {
        manager,
        now: Date.now,
        createGrant: async (s, a, input) =>
          workerLinkTunnelGrantSchema.parse(
            await api(
              `/api/worker-links/${s}/tunnel-attachments/${a}/grant`,
              input,
            ),
          ),
        renewGrant: async (s, g) =>
          workerLinkLeaseSchema.parse(
            await api(`/api/worker-links/${s}/grants/${g}/renew`, {}),
          ),
        revokeGrant: async (s, g) => {
          await api(`/api/worker-links/${s}/grants/${g}`, undefined, "DELETE");
        },
      },
    );
    connection.activate();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    return {
      port: (listener.address() as { port: number }).port,
      ssh: connection.ssh,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
