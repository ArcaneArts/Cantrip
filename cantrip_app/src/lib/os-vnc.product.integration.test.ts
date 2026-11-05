import { randomUUID, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import {
  clearSensitiveBytes,
  deriveComponentKey,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  tunnelUserWireCreateSchema,
} from "@cantrip/protocol";
import {
  tunnelContentRecordSchema,
  type TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";
import { productTestContext } from "./os-product-test-support";
import { productTestForward } from "./os-product-test-forward";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recoveryPath = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
describe.skipIf(!origin || !recoveryPath)(
  "actual product controlled VNC",
  () => {
    it("receives a real desktop framebuffer through saved encrypted routing and the actual WorkerLink relay", async () => {
      const context = await productTestContext(origin!, recoveryPath!);
      let tunnelId: string | undefined,
        forward: Awaited<ReturnType<typeof productTestForward>> | undefined;
      let content: TunnelContentRecord | undefined,
        socket: ReturnType<typeof connect> | undefined;
      const keep = process.env.CANTRIP_OS_PRODUCT_TEST_KEEP_VNC_TUNNEL === "1";
      try {
        const tunnels = tunnelWireListSchema.parse(
          await context.api("/api/tunnels"),
        );
        const source = tunnels.find(
          (t) =>
            t.osSource &&
            t.destination.kind === "worker-adapter" &&
            t.destination.adapter === "cantrip-os",
        );
        expect(source?.osSource).toBeDefined();
        tunnelId = randomUUID();
        content = tunnelContentRecordSchema.parse({
          name: "CantripOS VNC product acceptance",
          description: null,
          source: { kind: "desktop-loopback" },
          destination: {
            kind: "worker-os-vnc",
            workerId: source!.destination.workerId,
            source: source!.osSource,
          },
          dataProtection: {
            formatVersion: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            key: randomBytes(32).toString("base64url"),
          },
        });
        const key = deriveComponentKey({
          accountMasterKey: context.master,
          ownerId: context.recovery.ownerId,
          component: "tunnel-content",
          keyRevision: context.recovery.masterKeyRevision,
        });
        const plaintext = new TextEncoder().encode(JSON.stringify(content));
        let protectedContent;
        try {
          protectedContent = await encryptEndpointContentPayload({
            ownerId: context.recovery.ownerId,
            componentKey: key,
            keyRevision: context.recovery.masterKeyRevision,
            plaintext,
            context: {
              domain: "tunnel-content",
              serverId: context.recovery.serverId,
              workerId: source!.destination.workerId,
              scopeId: JSON.stringify(["tunnel", tunnelId]),
              operationId: tunnelId,
              operation: "tunnel.record",
              direction: "stored",
              sequence: 1,
            },
          });
        } finally {
          clearSensitiveBytes(key);
          clearSensitiveBytes(plaintext);
        }
        const tunnel = tunnelWireSummarySchema.parse(
          await context.api(
            "/api/tunnels",
            tunnelUserWireCreateSchema.parse({
              id: tunnelId,
              projectId: source!.projectId,
              protocolHint: "tcp",
              destination: {
                kind: "worker-adapter",
                adapter: "cantrip-os",
                resourceId: tunnelId,
                workerId: source!.destination.workerId,
              },
              osSource: source!.osSource,
              protectedRecord: {
                operationId: tunnelId,
                revision: 1,
                protectedContent,
              },
            }),
          ),
        );
        forward = await productTestForward(context, tunnel, content);
        socket = connect({ host: "127.0.0.1", port: forward.port });
        await once(socket, "connect");
        const { RfbClient } = await import(
          new URL(
            "../../../cantrip_worker/test/fixtures/rfb-client.ts",
            import.meta.url,
          ).href
        );
        const rfb = new RfbClient(socket),
          display = await rfb.initialize();
        expect(display.width).toBeGreaterThanOrEqual(800);
        expect(display.height).toBeGreaterThanOrEqual(600);
        expect(
          await rfb.rawFrame(
            display.width,
            display.height,
            display.bitsPerPixel,
          ),
        ).toBeGreaterThanOrEqual(display.width * display.height);
        rfb.pointer(321, 234, 0);
        rfb.key(65307, true);
        rfb.key(65307, false);
        const hold = Math.min(
          60_000,
          Math.max(
            0,
            Number(process.env.CANTRIP_OS_PRODUCT_TEST_VNC_HOLD_MS) || 0,
          ),
        );
        if (hold) {
          process.stdout.write(
            `Product VNC client ready on disposable route ${tunnelId}; holding for browser inspection.\n`,
          );
          await new Promise((resolve) => setTimeout(resolve, hold));
        }
        socket.end();
        socket.destroy();
        socket = undefined;
        await forward.close();
        forward = undefined;
      } finally {
        socket?.destroy();
        await forward?.close();
        if (content) content.dataProtection.key = "";
        if (tunnelId && !keep)
          await context.api(`/api/tunnels/${tunnelId}`, undefined, "DELETE");
        await context.close();
      }
    }, 90_000);
  },
);
