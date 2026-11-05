import { productTestContext } from "./os-product-test-support";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearSensitiveBytes,
  decryptEndpointContentPayload,
  deriveComponentKey,
} from "@cantrip/crypto";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  tunnelAttachmentCreateResultSchema,
  tunnelWireListSchema,
  workerLinkTunnelGrantSchema,
  workerLinkLeaseSchema,
  type TunnelDataPlaneFrameHeader,
  type TunnelWireSummary,
} from "@cantrip/protocol";
import { tunnelContentRecordSchema } from "@cantrip/protocol/tunnel-content";
import {
  openTunnelWorkerLink,
  type TunnelWorkerLinkConnection,
} from "./tunnel-worker-link";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recoveryPath = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;

/** Opt-in private QA profile only. No account key, ciphertext or credential is logged. */
describe.skipIf(!origin || !recoveryPath)(
  "actual Cantrip product OS tunnel",
  () => {
    it("uses the saved encrypted route and WorkerLink grant to reach Linux rather than the matching Host port", async () => {
      const context = await productTestContext(origin!, recoveryPath!);
      const { master, recovery, api, manager } = context;
      try {
        const tunnels = tunnelWireListSchema.parse(await api("/api/tunnels"));
        const guests = tunnels.filter(
          (tunnel) =>
            tunnel.destination.kind === "worker-adapter" &&
            tunnel.destination.adapter === "cantrip-os" &&
            (process.env.CANTRIP_OS_PRODUCT_TEST_TUNNEL_ID
              ? tunnel.id === process.env.CANTRIP_OS_PRODUCT_TEST_TUNNEL_ID
              : tunnel.protocolHint === "http"),
        );
        expect(guests).toHaveLength(1);
        const guest = guests[0]!;
        const peer = tunnels.find(
          (tunnel) =>
            tunnel.destination.kind === "worker-tcp" &&
            tunnel.projectId === guest.projectId,
        );
        expect(peer).toBeDefined();
        const protection = await import(
          new URL(
            "../../../cantrip_worker/src/tunnel-data-protection.ts",
            import.meta.url,
          ).href
        );

        async function requestThrough(
          tunnel: TunnelWireSummary,
          pathname: string,
        ) {
          const record = tunnel.protectedRecord!;
          const key = deriveComponentKey({
            accountMasterKey: master,
            ownerId: recovery.ownerId,
            component: "tunnel-content",
            keyRevision: record.protectedContent.keyRevision,
          });
          let plaintext: Uint8Array | undefined;
          try {
            plaintext = await decryptEndpointContentPayload({
              ownerId: recovery.ownerId,
              context: {
                domain: "tunnel-content",
                serverId: recovery.serverId,
                workerId: tunnel.destination.workerId,
                scopeId: JSON.stringify(["tunnel", tunnel.id]),
                operationId: record.operationId,
                operation: "tunnel.record",
                direction: "stored",
                sequence: record.revision,
              },
              keyRevision: record.protectedContent.keyRevision,
              componentKey: key,
              opaque: record.protectedContent,
            });
            const content = tunnelContentRecordSchema.parse(
              JSON.parse(new TextDecoder().decode(plaintext)),
            );
            const attachment = tunnelAttachmentCreateResultSchema.parse(
              await api(`/api/tunnels/${tunnel.id}/attachments`, {
                clientId: randomUUID(),
              }),
            );
            let connection: TunnelWorkerLinkConnection | undefined;
            let base: {
              protocolVersion: 1;
              tunnelId: string;
              attachmentId: string;
              sourceEndpointId: string;
              destinationEndpointId: string;
              connectionId: string;
            };
            let sequence = 1;
            const chunks: Uint8Array[] = [];
            let finish!: () => void, fail!: (error: Error) => void;
            const completed = new Promise<void>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            });
            const timeout = setTimeout(
              () =>
                fail(
                  new Error("The actual product tunnel response timed out."),
                ),
              30_000,
            );
            try {
              connection = await openTunnelWorkerLink(
                {
                  attachmentId: attachment.attachmentId,
                  workerId: tunnel.destination.workerId,
                  onClose: (code) => {
                    if (code !== "normal")
                      fail(new Error(`Product WorkerLink closed: ${code}`));
                  },
                  onFrame(bytes) {
                    const frame = decodeTunnelDataPlaneFrame(bytes);
                    if (frame.header.kind === "accepted") {
                      const data = new TextEncoder().encode(
                        `GET ${pathname} HTTP/1.1\r\nHost: phase4-test\r\nConnection: close\r\n\r\n`,
                      );
                      const encrypted = protection.sealTunnelDataFrame(
                        content.dataProtection,
                        {
                          ...base,
                          kind: "data",
                          sequence: sequence++,
                          direction: "source-to-destination",
                        },
                        data,
                      );
                      connection!.send(
                        encodeTunnelDataPlaneFrame(
                          encrypted.header,
                          encrypted.payload,
                        ),
                      );
                      connection!.send(
                        encodeTunnelDataPlaneFrame(
                          {
                            ...base,
                            kind: "half-close",
                            sequence: sequence++,
                            direction: "source-to-destination",
                          },
                          new Uint8Array(),
                        ),
                      );
                    } else if (frame.header.kind === "data") {
                      const data: Uint8Array = protection.openTunnelDataFrame(
                        content.dataProtection,
                        frame.header,
                        frame.payload,
                      );
                      chunks.push(data);
                      connection!.send(
                        encodeTunnelDataPlaneFrame(
                          {
                            ...base,
                            kind: "credit",
                            sequence: sequence++,
                            direction: "destination-to-source",
                            bytes: data.length,
                          },
                          new Uint8Array(),
                        ),
                      );
                    } else if (
                      frame.header.kind === "half-close" ||
                      frame.header.kind === "close"
                    )
                      finish();
                    else if (
                      frame.header.kind === "rejected" ||
                      frame.header.kind === "error"
                    )
                      fail(
                        new Error(
                          `Product destination rejected: ${frame.header.code}`,
                        ),
                      );
                  },
                },
                {
                  manager: manager!,
                  now: Date.now,
                  createGrant: async (sessionId, attachmentId, input) =>
                    workerLinkTunnelGrantSchema.parse(
                      await api(
                        `/api/worker-links/${sessionId}/tunnel-attachments/${attachmentId}/grant`,
                        input,
                      ),
                    ),
                  renewGrant: async (sessionId, grantId) =>
                    workerLinkLeaseSchema.parse(
                      await api(
                        `/api/worker-links/${sessionId}/grants/${grantId}/renew`,
                        {},
                      ),
                    ),
                  revokeGrant: async (sessionId, grantId) => {
                    await api(
                      `/api/worker-links/${sessionId}/grants/${grantId}`,
                      undefined,
                      "DELETE",
                    );
                  },
                },
              );
              const route = connection.tunnelRoute;
              base = {
                protocolVersion: 1,
                tunnelId: route.tunnelId,
                attachmentId: route.attachmentId,
                sourceEndpointId: route.sourceEndpointId,
                destinationEndpointId: route.destinationEndpointId,
                connectionId: randomUUID(),
              };
              connection.activate();
              connection.send(
                encodeTunnelDataPlaneFrame(
                  {
                    ...base,
                    kind: "connect",
                    sequence: 0,
                    initialCreditBytes: 256 * 1024,
                    target: route.target,
                  },
                  new Uint8Array(),
                ),
              );
              await completed;
              return new TextDecoder().decode(Buffer.concat(chunks));
            } finally {
              clearTimeout(timeout);
              connection?.close();
              await api(
                `/api/tunnel-attachments/${attachment.attachmentId}`,
                undefined,
                "DELETE",
              );
            }
          } finally {
            clearSensitiveBytes(key);
            if (plaintext) clearSensitiveBytes(plaintext);
          }
        }
        const host = await requestThrough(peer!, "/phase4-service-proof.txt");
        expect(host).toContain("HOST SHADOW: this is the wrong destination");
        const linux = await requestThrough(guest, "/phase4-service-proof.txt");
        expect(linux).toContain("200 OK");
        expect(linux).toContain("CantripOS managed TCP product proof");
        expect(linux).not.toContain("HOST SHADOW");
      } finally {
        await context.close();
      }
    }, 90_000);
  },
);
