import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  clearSensitiveBytes,
  deriveComponentKey,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  tunnelAttachmentCreateResultSchema,
  workerLinkTunnelGrantSchema,
  workerLinkLeaseSchema,
} from "@cantrip/protocol";
import { tunnelContentRecordSchema } from "@cantrip/protocol/tunnel-content";
import { productTestContext } from "./os-product-test-support";
import { startOsReverseTunnel, stopOsReverseTunnel } from "./os-reverse-tunnel";
import { openTunnelWorkerLink } from "./tunnel-worker-link";
const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN,
  recovery = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
const run = promisify(execFile);
const container =
  process.env.CANTRIP_OS_PRODUCT_TEST_CONTAINER ??
  "cantrip-os-phase4-product-pg";
const guest = (script: string) =>
  run("docker", ["exec", container, "python3", "-c", script], {
    timeout: 30000,
    maxBuffer: 65536,
  });
describe.skipIf(!origin || !recovery)(
  "actual saved Guest-to-Host product route",
  () => {
    it("starts from the browser controller, uses an authorized WorkerLink lease, reaches Host rather than matching Linux loopback, and retires its listener", async () => {
      const context = await productTestContext(origin!, recovery!);
      const { api, master, manager } = context;
      let savedId: string | undefined;
      const tunnelId = randomUUID(),
        port = 51566;
      try {
        const tunnels = tunnelWireListSchema.parse(await api("/api/tunnels"));
        const peer = tunnels.find(
          (item) =>
            item.destination.kind === "worker-adapter" &&
            item.destination.adapter === "cantrip-os" &&
            item.osSource,
        )!;
        expect(peer).toBeDefined();
        const source = peer.osSource!,
          workerId = peer.destination.workerId,
          revision = peer.protectedRecord!.protectedContent.keyRevision;
        const content = tunnelContentRecordSchema.parse({
          name: "Product reverse acceptance",
          description: null,
          source: { kind: "worker-os-listener", workerId, source, port },
          destination: {
            kind: "worker-tcp",
            workerId,
            host: "127.0.0.1",
            port: 51458,
          },
          dataProtection: {
            formatVersion: 1,
            algorithm: "AES-256-GCM",
            keyRevision: revision,
            key: randomBytes(32).toString("base64url"),
          },
        });
        const componentKey = deriveComponentKey({
          accountMasterKey: master,
          ownerId: context.recovery.ownerId,
          component: "tunnel-content",
          keyRevision: revision,
        });
        const plaintext = new TextEncoder().encode(JSON.stringify(content));
        let protectedContent;
        try {
          protectedContent = await encryptEndpointContentPayload({
            ownerId: context.recovery.ownerId,
            keyRevision: revision,
            componentKey,
            plaintext,
            context: {
              domain: "tunnel-content",
              serverId: context.recovery.serverId,
              workerId,
              scopeId: JSON.stringify(["tunnel", tunnelId]),
              operationId: tunnelId,
              operation: "tunnel.record",
              direction: "stored",
              sequence: 1,
            },
          });
        } finally {
          clearSensitiveBytes(componentKey);
          clearSensitiveBytes(plaintext);
        }
        const saved = tunnelWireSummarySchema.parse(
          await api("/api/tunnels", {
            id: tunnelId,
            projectId: peer.projectId,
            protocolHint: "http",
            source: { kind: "worker-listener", workerId },
            destination: { kind: "worker-tcp", workerId },
            osSource: source,
            protectedRecord: {
              operationId: tunnelId,
              revision: 1,
              protectedContent,
            },
          }),
        );
        savedId = saved.id;
        expect(saved.source.kind).toBe("worker-listener");
        expect(JSON.stringify(saved)).not.toContain('"port"');
        const summary = await startOsReverseTunnel(tunnelId, {
          serverUrl: origin!,
          dependencies: {
            configuration: async () => ({
              source: content.source,
              destination: content.destination,
              workerId,
              revision: 1,
              dataProtection: { ...content.dataProtection },
            }),
            create: async (id, input) =>
              tunnelAttachmentCreateResultSchema.parse(
                await api(`/api/tunnels/${id}/attachments`, input),
              ),
            remove: async (id) => {
              await api(`/api/tunnel-attachments/${id}`, undefined, "DELETE");
            },
            open: (options) =>
              openTunnelWorkerLink(options, {
                manager,
                now: Date.now,
                createGrant: async (session, attachment, input) => {
                  const issued = workerLinkTunnelGrantSchema.parse(
                    await api(
                      `/api/worker-links/${session}/tunnel-attachments/${attachment}/grant`,
                      input,
                    ),
                  );
                  expect(issued.grant.binding.operations).toContain(
                    "stream:guest-listen",
                  );
                  expect(issued.grant.binding.operations).not.toContain(
                    "stream:guest-connect",
                  );
                  return issued;
                },
                renewGrant: async (session, grant) =>
                  workerLinkLeaseSchema.parse(
                    await api(
                      `/api/worker-links/${session}/grants/${grant}/renew`,
                      {},
                    ),
                  ),
                revokeGrant: async (session, grant) => {
                  await api(
                    `/api/worker-links/${session}/grants/${grant}`,
                    undefined,
                    "DELETE",
                  );
                },
              }),
          },
        });
        expect(summary.status).toBe("active");
        expect(summary.route).toBe("relay");
        const proof = await guest(
          `import urllib.request,os\nos.setgid(20000);os.setuid(20000)\nprint(urllib.request.urlopen('http://127.0.0.1:${port}/phase4-reverse-proof',timeout=20).read().decode().strip())\nprint(urllib.request.urlopen('http://127.0.0.1:51458/phase4-service-proof.txt',timeout=20).read().decode().strip())`,
        );
        expect(proof.stdout).toContain(
          "HOST SHADOW: this is the wrong destination",
        );
        expect(proof.stdout).toContain("CantripOS managed TCP product proof");
        // Exercise the real nonempty control heartbeat through SDK, relay and Worker.
        await new Promise((resolve) => setTimeout(resolve, 21000));
        expect(
          (
            await guest(
              `import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:${port}/after-heartbeat',timeout=20).read().decode().strip())`,
            )
          ).stdout,
        ).toContain("HOST SHADOW");
        await stopOsReverseTunnel(tunnelId, origin!);
        expect(
          (
            await guest(
              `import socket\ns=socket.socket();s.settimeout(5)\nassert s.connect_ex(('127.0.0.1',${port}))!=0\nprint('listener retired')`,
            )
          ).stdout.trim(),
        ).toBe("listener retired");
      } finally {
        await stopOsReverseTunnel(tunnelId, origin!).catch(() => {});
        if (savedId) await api(`/api/tunnels/${savedId}`, undefined, "DELETE");
        await context.close();
      }
    }, 120000);
  },
);
