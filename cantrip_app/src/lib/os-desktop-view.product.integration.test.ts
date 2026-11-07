// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  clearSensitiveBytes,
  decryptRemoteSurfaceStreamPayload,
  deriveComponentKey,
  encryptPrivateDisplayLabel,
  encryptRemoteSurfaceStreamPayload,
  encryptSurfacePrivateState,
} from "@cantrip/crypto";
import {
  remoteDesktopServerMessageSchema,
  remoteDesktopWireSummarySchema,
  workerLinkLeaseSchema,
  workerLinkResourceGrantSchema,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { productTestContext } from "./os-product-test-support";
import {
  RemoteSurfaceWorkerLinkClient,
  type RemoteSurfaceWorkerLinkRoutes,
} from "./remote-surface-worker-link";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recovery = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
const projectId = process.env.CANTRIP_OS_PRODUCT_TEST_PROJECT;
const bindingId = process.env.CANTRIP_OS_PRODUCT_TEST_BINDING;
const runtimeGeneration = process.env.CANTRIP_OS_PRODUCT_TEST_RUNTIME;

describe.skipIf(
  !origin || !recovery || !projectId || !bindingId || !runtimeGeneration,
)("actual product source-bound Linux desktop view", () => {
  it("creates an encrypted view and receives authenticated JPEG frames without acquiring human control", async () => {
    const context = await productTestContext(origin!, recovery!);
    const key = deriveComponentKey({
      accountMasterKey: context.master,
      ownerId: context.recovery.ownerId,
      component: "surface-private-state",
      keyRevision: context.recovery.masterKeyRevision,
    });
    const labelKey = deriveComponentKey({
      accountMasterKey: context.master,
      ownerId: context.recovery.ownerId,
      component: "private-surface-metadata",
      keyRevision: context.recovery.masterKeyRevision,
    });
    const id = randomUUID();
    let client: RemoteSurfaceWorkerLinkClient | undefined;
    let created = false;
    let image: Uint8Array | undefined;
    let size: { width: number; height: number } | undefined;
    let routes: RemoteSurfaceWorkerLinkRoutes | undefined;
    let failure: unknown;
    const controls: Array<{ mode: string; isController: boolean }> = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const complete = () => {
      if (failure || (image && size && controls.length)) finish();
    };
    try {
      const stateProtection = await encryptSurfacePrivateState({
        ownerId: context.recovery.ownerId,
        componentKey: key,
        keyRevision: context.recovery.masterKeyRevision,
        context: {
          serverId: context.recovery.serverId,
          resource: "remote-desktop-row",
          resourceId: id,
          operationId: null,
          recordKind: "remote-desktop-state",
        },
        content: {
          version: 1,
          classification: { recordKind: "remote-desktop-state" },
          revision: 1,
          target: { kind: "monitor", id: null, name: null },
        },
      });
      const titleProtection = await encryptPrivateDisplayLabel({
        ownerId: context.recovery.ownerId,
        componentKey: labelKey,
        keyRevision: context.recovery.masterKeyRevision,
        rowId: id,
        recordKind: "project-view",
        label: "CantripOS product desktop acceptance",
      });
      const desktop = remoteDesktopWireSummarySchema.parse(
        await context.api(`/api/projects/${projectId}/remote-desktops`, {
          id,
          stateProtection,
          titleProtection,
          cantripOsBindingId: bindingId,
          cantripOsRuntimeGeneration: runtimeGeneration,
        }),
      );
      created = true;
      expect(desktop.osSource?.bindingId).toBe(bindingId);
      expect(desktop.osSource?.runtimeGeneration).toBe(runtimeGeneration);
      expect(desktop.osSource?.desktopGeneration).toMatch(/^[a-f0-9]{64}$/);
      client = new RemoteSurfaceWorkerLinkClient(
        {
          messages: {
            connectionError: "Product desktop connection failed",
            invalidFrame: "Invalid protected product desktop frame",
          },
          streamKind: "desktop",
          surfaceKind: "remote-desktop",
          surfaceId: id,
          workerId: desktop.workerId,
          viewport: () => ({ width: 1440, height: 900, devicePixelRatio: 1 }),
          onConnectionState() {},
          onReady(value) {
            routes = value;
            // Match the viewer's ready effect: publish current control state
            // after both WorkerLink lanes can receive it.
            expect(
              client!.send(
                "control",
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "viewport",
                    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
                  }),
                ),
              ),
            ).toBe(true);
          },
          onError(message) {
            if (message) {
              failure = new Error(message);
              finish();
            }
          },
          onFrame(frame) {
            try {
              if (frame.header.channel === "frame") {
                image ??= Uint8Array.from(frame.payload);
              } else if (frame.header.channel === "control") {
                const message = remoteDesktopServerMessageSchema.parse(
                  JSON.parse(new TextDecoder().decode(frame.payload)),
                );
                if (message.type === "desktop-state") {
                  expect(message.status).toBe("ready");
                  size = { width: message.width, height: message.height };
                } else if (message.type === "desktop-control") {
                  expect(message.mode).toBe("agent");
                  expect(message.isController).toBe(false);
                  controls.push({
                    mode: message.mode,
                    isController: message.isController,
                  });
                }
              }
            } catch (error) {
              failure = error;
            }
            complete();
          },
        },
        {
          manager: context.manager,
          now: Date.now,
          createGrant: async (session, surface, viewport) =>
            workerLinkResourceGrantSchema.parse(
              await context.api(
                `/api/worker-links/${session}/remote-surfaces/${surface}/grant`,
                { viewport },
              ),
            ),
          renewGrant: async (session, grant) =>
            workerLinkLeaseSchema.parse(
              await context.api(
                `/api/worker-links/${session}/grants/${grant}/renew`,
                {},
              ),
            ),
          revokeGrant: async (session, grant) => {
            await context.api(
              `/api/worker-links/${session}/grants/${grant}`,
              undefined,
              "DELETE",
            );
          },
          openPayload: ({ context: streamContext, protectedPayload }) =>
            decryptRemoteSurfaceStreamPayload({
              ownerId: context.recovery.ownerId,
              componentKey: key,
              keyRevision: context.recovery.masterKeyRevision,
              context: {
                ...streamContext,
                serverId: context.recovery.serverId,
              },
              protectedPayload,
            }),
          protectPayload: ({ context: streamContext, payload }) =>
            encryptRemoteSurfaceStreamPayload({
              ownerId: context.recovery.ownerId,
              componentKey: key,
              keyRevision: context.recovery.masterKeyRevision,
              context: {
                ...streamContext,
                serverId: context.recovery.serverId,
              },
              plaintext: payload,
            }),
        },
      );
      client.start();
      const deadline = setTimeout(finish, 20_000);
      try {
        await done;
      } finally {
        clearTimeout(deadline);
      }
      if (failure) throw failure;
      expect(size?.width).toBeGreaterThanOrEqual(800);
      expect(size?.height).toBeGreaterThanOrEqual(600);
      expect(controls.length).toBeGreaterThan(0);
      expect(image?.byteLength).toBeGreaterThan(1_000);
      expect(Array.from(image!.subarray(0, 2))).toEqual([0xff, 0xd8]);
      expect(Array.from(image!.subarray(-2))).toEqual([0xff, 0xd9]);
      const evidence = process.env.CANTRIP_OS_PRODUCT_TEST_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(path.join(evidence, "product-desktop.jpg"), image!);
        await writeFile(
          path.join(evidence, "desktop-view-product.json"),
          JSON.stringify(
            {
              id,
              projectId,
              workerId: desktop.workerId,
              osSource: desktop.osSource,
              routes,
              size,
              controls,
              imageBytes: image!.byteLength,
              imageSha256: createHash("sha256").update(image!).digest("hex"),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      client?.close();
      try {
        if (created)
          await context.api(`/api/project-views/${id}`, undefined, "DELETE");
      } finally {
        try {
          await context.close();
        } finally {
          clearSensitiveBytes(key);
          clearSensitiveBytes(labelKey);
        }
      }
    }
  }, 90_000);
});
