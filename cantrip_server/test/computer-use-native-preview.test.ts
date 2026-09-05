import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cuaInventorySchema,
  cuaSessionResultSchema,
  cuaSnapshotSchema,
} from "@cantrip/protocol/computer-use";
import {
  createComputerUseClient,
  type ComputerUseClient,
  type ComputerUseClientDependencies,
} from "../../cantrip_app/src/lib/computer-use-client";
import { createComputerUsePreviewFixture } from "./support/computer-use-preview-fixture.js";

// Only synthetic endpoint dependencies below. Importing this default-skipped
// test cannot initialize real accounts, browser storage, or native capture.
vi.mock("../../cantrip_app/src/lib/api-client", () => ({
  request: () => {
    throw new Error("Unbound application request.");
  },
}));
vi.mock("../../cantrip_app/src/lib/client-encryption", () => ({
  clientEncryption: {},
}));
vi.mock("../../cantrip_app/src/lib/client-session", () => ({
  clientSessionIdentityMatches: () => false,
  getClientSessionIdentitySnapshot: () => null,
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("../../cantrip_app/src/lib/server-connections", () => ({
  getActiveServerUrl: () => {
    throw new Error("Unbound application server.");
  },
}));

// Deliberately independent of CANTRIP_CUA_TEST_BINARY, which enables fake
// portable tests. Setting this explicit path authorizes native fixture capture.
const binary = process.env.CANTRIP_CUA_NATIVE_TEST_BINARY;
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  let failure: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});

type Fixture = ReturnType<typeof createComputerUsePreviewFixture>;
function client(f: Fixture) {
  const { ownerId, serverId, chatId, componentKey } = f.credentials;
  const identity = {
    accountId: null,
    connectionId: "native-fixture-connection",
    generation: 1,
    incarnationId: "native-fixture-incarnation",
    serverId,
    serverUrl: "http://fixture.invalid",
    userId: ownerId,
  };
  const request: NonNullable<ComputerUseClientDependencies["request"]> = async <
    T,
  >(
    url: string,
    init?: RequestInit,
    behavior?: Parameters<
      NonNullable<ComputerUseClientDependencies["request"]>
    >[2],
  ) => {
    expect(behavior).toEqual({
      allowCsrfRecovery: false,
      expectedIdentity: identity,
    });
    if (init?.signal?.aborted) throw new Error("Cancelled fixture request.");
    const address = new URL(url);
    f.wire.push(String(init?.body ?? ""));
    const response = await f.app.inject({
      method: "POST",
      url: address.pathname + address.search,
      payload: JSON.parse(String(init?.body ?? "{}")),
    });
    f.wire.push(response.body);
    if (response.statusCode !== 200)
      throw new Error(`Native fixture HTTP ${response.statusCode}`);
    return response.json() as T;
  };
  const viewer = createComputerUseClient(chatId, {
    request,
    sessionIdentity: () => identity,
    identityMatches: (expected) =>
      JSON.stringify(expected) === JSON.stringify(identity),
    onIdentityChanged: () => () => {},
    serverUrl: () => identity.serverUrl,
    encryption: {
      getSnapshot: () => ({
        clientId: "native-fixture-client",
        identity: { ownerId, serverId },
        masterKeyRevision: 1,
        status: "ready",
      }),
      componentKey: () => componentKey.slice(),
      subscribe: () => () => {},
    },
  });
  cleanup.push(() => viewer.dispose());
  return viewer;
}
function data(response: Awaited<ReturnType<ComputerUseClient["operation"]>>) {
  // Do not print screenshots, arbitrary inventory titles, or raw native errors.
  if (response.content.status !== "ok")
    throw new Error(
      `Native preview operation failed: ${response.content.code}`,
    );
  return response.content.data;
}

describe.skipIf(!binary)(
  "opt-in real macOS fixture through encrypted app preview",
  () => {
    it("captures its occluded window, renders a logical cursor, and stops through the actual client route", async () => {
      if (!path.isAbsolute(binary!))
        throw new Error(
          "CANTRIP_CUA_NATIVE_TEST_BINARY must name an absolute installed helper path.",
        );
      const {
        launchNativeFixture,
        verifyFixturePixels,
        verifyFixtureGeometry,
      } = await import("../../scripts/cantrip-cua/native-smoke.mjs");
      const requireWorker = createRequire(
        new URL("../../cantrip_worker/package.json", import.meta.url),
      );
      const sharp = requireWorker("sharp") as typeof import("sharp");
      const native = await launchNativeFixture();
      cleanup.push(() => native.dispose());
      const f = createComputerUsePreviewFixture({
        binary: binary!,
        backend: "native",
        permissionProfile: ":yolo",
      });
      cleanup.push(() => f.close());
      const viewer = client(f);
      const lease = await viewer.open();
      expect(f.launchCount).toBe(0);
      expect(f.service.status().sessions).toBe(0);
      const capability = await viewer.operation(lease, {
        operation: "capabilities.get",
      });
      expect(data(capability)).toMatchObject({
        capture: true,
        backend: "macos-screencapturekit",
        nativeInput: false,
      });
      const inventory = cuaInventorySchema.parse(
        data(await viewer.operation(lease, { operation: "targets.list" })),
      );
      // Capture only the known owned fixture PID and exact target window handle.
      // Never select another user window or substitute a monitor.
      const target = inventory.targets.find(
        (candidate) =>
          candidate.id === `macos-window-${native.initial.windowId}` &&
          candidate.processId === native.initial.processId &&
          candidate.kind === "window",
      );
      if (!target)
        throw new Error("Owned native fixture window was not enumerated.");
      const selected = {
        targetId: target.id,
        targetGeneration: target.generation,
      };
      const session = cuaSessionResultSchema.parse(
        data(
          await viewer.operation(lease, {
            operation: "session.open",
            ...selected,
          }),
        ),
      ).session;
      const sessionId = session.binding.sessionId;
      const appearance = {
        version: 1 as const,
        visible: true,
        style: "dot" as const,
        color: "#FFFFFF",
        size: 20,
        label: "Native fixture cursor",
        trail: false,
      };
      const configured = cuaSessionResultSchema.parse(
        data(
          await viewer.operation(lease, {
            operation: "cursor.configure",
            sessionId,
            ...selected,
            appearance,
          }),
        ),
      ).session;
      expect(configured.cursor.appearance).toEqual(appearance);
      const position = {
        x: target.bounds.width * 0.3,
        y: target.bounds.height * 0.3,
      };
      data(
        await viewer.operation(lease, {
          operation: "cursor.move",
          sessionId,
          ...selected,
          position,
        }),
      );
      let observations = 0;
      for (const scenario of ["foreground", "full"] as const) {
        const state =
          scenario === "foreground"
            ? native.initial
            : await native.command(scenario);
        if (scenario === "full") expect(state.occluded).toBe(true);
        const response = await viewer.operation(lease, {
          operation: "observation.snapshot",
          sessionId,
          ...selected,
        });
        if (!response.bytes)
          throw new Error("Native snapshot bytes were not delivered.");
        let decoded: Buffer | undefined;
        try {
          const snapshot = cuaSnapshotSchema.parse(data(response));
          expect(snapshot.session.target?.id).toBe(target.id);
          expect(snapshot.session.target?.kind).toBe("window");
          verifyFixtureGeometry(
            snapshot.session.target,
            state,
            target,
            scenario,
          );
          const raster = await sharp(response.bytes, {
            limitInputPixels: 4_194_304,
          })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          decoded = raster.data;
          expect(raster.info.width).toBe(snapshot.image.width);
          expect(raster.info.height).toBe(snapshot.image.height);
          // These five patches reject the blue occluder, a monitor substitute,
          // wrong channel order, and vertical flips; pixels never leave memory.
          expect(
            verifyFixturePixels({
              data: decoded,
              width: raster.info.width,
              height: raster.info.height,
            }),
          ).toBe(true);
          const bounds = snapshot.session.target!.bounds;
          const x = Math.floor((position.x * raster.info.width) / bounds.width);
          const y = Math.floor(
            (position.y * raster.info.height) / bounds.height,
          );
          const offset = (y * raster.info.width + x) * 4;
          expect([...decoded.subarray(offset, offset + 4)]).toEqual([
            255, 255, 255, 255,
          ]);
          expect(snapshot.image.cursorIncluded).toBe(true);
          expect(snapshot.session.cursor.position).toEqual(position);
          const transport = f.wire.join("\n") + f.logs.join("\n");
          expect(
            transport.includes(Buffer.from(response.bytes).toString("base64")),
          ).toBe(false);
          observations++;
        } finally {
          response.bytes.fill(0);
          decoded?.fill(0);
        }
      }
      expect(observations).toBe(2);
      expect(f.launchCount).toBe(1);
      expect(f.service.status().sessions).toBe(1);
      await viewer.stop(lease);
      expect(f.service.status().sessions).toBe(0);
      expect(f.coordinator.status().previews).toBe(0);
      expect(f.approvals.status().pending).toBe(0);
      const transport = f.wire.join("\n") + f.logs.join("\n");
      for (const privateText of [
        "Native fixture cursor",
        "Cantrip CUA fixture target",
        "Cantrip CUA fixture occluder",
        Buffer.from(f.credentials.componentKey).toString("base64"),
      ])
        expect(transport.includes(privateText)).toBe(false);
    }, 30000);
  },
);
