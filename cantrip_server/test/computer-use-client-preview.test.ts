import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
} from "../../packages/crypto/src/index.js";
import {
  agentInteractionRequestPayloadSchema,
  encryptedAgentInteractionRequestSchema,
} from "@cantrip/protocol";
import {
  cuaSessionResultSchema,
  type ComputerUseAction,
} from "@cantrip/protocol/computer-use";
import {
  createComputerUseClient,
  type ComputerUseClient,
  type ComputerUseClientDependencies,
} from "../../cantrip_app/src/lib/computer-use-client";
import { createComputerUsePreviewFixture } from "./support/computer-use-preview-fixture.js";

// All dependencies are supplied below. Do not initialize browser application
// globals, IndexedDB, real profiles, or credentials in this Node integration.
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

type Fixture = ReturnType<typeof createComputerUsePreviewFixture>;
const close: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const operation of close.splice(0).reverse()) await operation();
});

function fixture(permissionProfile = ":yolo") {
  const f = createComputerUsePreviewFixture({
    binary: process.env.CANTRIP_CUA_TEST_BINARY!,
    permissionProfile,
  });
  close.push(() => f.close());
  return f;
}

function client(f: Fixture) {
  const { ownerId, serverId, chatId, componentKey } = f.credentials;
  const identity = {
    accountId: null,
    connectionId: "fixture-connection",
    generation: 1,
    incarnationId: "fixture-incarnation",
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
      throw new Error(`Fixture HTTP ${response.statusCode}`);
    return response.json() as T;
  };
  const result = createComputerUseClient(chatId, {
    request,
    sessionIdentity: () => identity,
    identityMatches: (expected) =>
      JSON.stringify(expected) === JSON.stringify(identity),
    onIdentityChanged: () => () => {},
    serverUrl: () => "http://fixture.invalid",
    encryption: {
      getSnapshot: () => ({
        clientId: "fixture-client",
        identity: { ownerId, serverId },
        masterKeyRevision: 1,
        status: "ready",
      }),
      componentKey: () => componentKey.slice(),
      subscribe: () => () => {},
    },
  });
  close.push(() => result.dispose());
  return result;
}

function session(
  response: Awaited<ReturnType<ComputerUseClient["operation"]>>,
) {
  expect(response.bytes).toBeNull();
  if (response.content.status !== "ok") throw new Error(response.content.code);
  return cuaSessionResultSchema.parse(response.content.data).session;
}

/** Decode only the real fixture's bounded 8-bit RGBA PNG; no production codec. */
function pixels(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const stride = width * 4;
  const encoded = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: (stride + 1) * height,
  });
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[y * (stride + 1)]!;
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x += 1) {
      const index = y * stride + x;
      const left = x >= 4 ? rgba[index - 4]! : 0;
      const up = y ? rgba[index - stride]! : 0;
      const corner = y && x >= 4 ? rgba[index - stride - 4]! : 0;
      const prediction = left + up - corner;
      const paeth =
        Math.abs(prediction - left) <= Math.abs(prediction - up) &&
        Math.abs(prediction - left) <= Math.abs(prediction - corner)
          ? left
          : Math.abs(prediction - up) <= Math.abs(prediction - corner)
            ? up
            : corner;
      rgba[index] =
        encoded[y * (stride + 1) + 1 + x]! +
        [0, left, up, Math.floor((left + up) / 2), paeth][filter]!;
    }
  }
  return {
    width,
    height,
    rgba,
    at: (x: number, y: number) => [
      ...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
    ],
  };
}

async function approvePending(f: Fixture) {
  const response = await f.app.inject({
    method: "GET",
    url: `/api/agent-requests?chatId=${f.credentials.chatId}&status=pending`,
  });
  expect(response.statusCode).toBe(200);
  const pending = response.json() as unknown[];
  expect(pending).toHaveLength(1);
  const record = encryptedAgentInteractionRequestSchema.parse(pending[0]);
  const content = await decryptInteractionRequestContent({
    ownerId: f.credentials.ownerId,
    requestKey: record.requestKey,
    keyRevision: 1,
    componentKey: f.credentials.componentKey,
    encrypted: record.protectedPayload,
    publicClassification: record.classification,
  });
  const payload = agentInteractionRequestPayloadSchema.parse(content.payload);
  if (payload.kind !== "permissions")
    throw new Error("Expected native permission request.");
  expect(record.provenance).toMatchObject({
    owner: "computer-use",
    threadId: null,
    turnId: null,
    executionLaneId: null,
  });
  const classification = { kind: "permissions" as const };
  const protectedResponse = await encryptInteractionResponseContent({
    ownerId: f.credentials.ownerId,
    requestKey: record.requestKey,
    keyRevision: 1,
    componentKey: f.credentials.componentKey,
    content: {
      version: 1,
      classification,
      response: {
        kind: "permissions",
        permissions: payload.requestedPermissions,
        scope: "session",
        strictAutoReview: false,
      },
    },
  });
  const accepted = await f.app.inject({
    method: "POST",
    url: `/api/agent-requests/${record.id}/respond`,
    payload: {
      idempotencyKey: randomUUID(),
      classification,
      protectedResponse,
    },
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().status).toBe("resolved");
}

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "actual browser client -> server -> worker -> Rust fake preview",
  () => {
    it("decrypts real cursor pixels and shares one session without making dismiss destructive", async () => {
      const f = fixture();
      const first = client(f),
        second = client(f),
        staleObserver = client(f);
      const lease = await first.open();
      const shared = await second.open();
      const staleLease = await staleObserver.open();
      expect(shared).toEqual(lease);
      expect(f.launchCount).toBe(0);
      const capability = await first.operation(lease, {
        operation: "capabilities.get",
      });
      expect(capability.content).toMatchObject({
        status: "ok",
        data: { backend: "fake", nativeInput: false },
      });
      const inventory = await first.operation(lease, {
        operation: "targets.list",
      });
      expect(inventory.content).toMatchObject({
        status: "ok",
        data: {
          targets: expect.arrayContaining([
            expect.objectContaining({
              id: "fake-window",
              title: "CUA fixture window",
            }),
          ]),
        },
      });
      const target = { targetId: "fake-window", targetGeneration: 1 };
      const opened = session(
        await first.operation(lease, { operation: "session.open", ...target }),
      );
      for (let observer = 0; observer < 20; observer += 1)
        expect(
          session(
            await second.operation(shared, {
              operation: "session.open",
              ...target,
            }),
          ).binding,
        ).toEqual(opened.binding);
      expect(f.service.status().sessions).toBe(1);
      const appearance = {
        version: 1 as const,
        style: "dot" as const,
        color: "#FF0066",
        size: 16,
        label: "Secret CUA",
        trail: false,
        visible: true,
      };
      session(
        await first.operation(lease, {
          operation: "cursor.configure",
          sessionId: opened.binding.sessionId,
          ...target,
          appearance,
        }),
      );
      session(
        await first.operation(lease, {
          operation: "cursor.move",
          sessionId: opened.binding.sessionId,
          ...target,
          position: { x: 50, y: 40 },
        }),
      );
      const snapshot: ComputerUseAction = {
        operation: "observation.snapshot",
        sessionId: opened.binding.sessionId,
        ...target,
      };
      const captured = await second.operation(shared, snapshot);
      expect(captured.content).toMatchObject({
        status: "ok",
        data: {
          image: { width: 320, height: 200, cursorIncluded: true },
          session: { cursor: { appearance } },
        },
      });
      expect(captured.bytes).not.toBeNull();
      const decoded = pixels(captured.bytes!);
      expect(decoded.at(100, 80)).toEqual([255, 0, 102, 255]);
      expect(decoded.at(300, 180)[2]).toBe(130);
      captured.bytes!.fill(0);
      decoded.rgba.fill(0);
      first.dispose();
      const continued = await second.operation(shared, snapshot);
      expect(continued.content.status).toBe("ok");
      continued.bytes?.fill(0);
      expect(f.service.status().sessions).toBe(1);
      await second.stop(shared);
      expect(f.service.status().sessions).toBe(0);
      expect(f.coordinator.status().previews).toBe(0);
      await expect(
        staleObserver.operation(staleLease, snapshot),
      ).rejects.toThrow("Fixture HTTP 502");
      expect(f.launchCount).toBe(1);
      const opaque = f.wire.join("\n") + f.logs.join("\n");
      expect(opaque).not.toContain("Secret CUA");
      expect(opaque).not.toContain("CUA fixture window");
      expect(opaque).not.toContain(
        Buffer.from(f.credentials.componentKey).toString("base64"),
      );
    });

    it("uses encrypted non-YOLO approval and waits for explicit retry before native work", async () => {
      const f = fixture(":default");
      const viewer = client(f);
      const lease = await viewer.open();
      const action = {
        operation: "session.open",
        targetId: "fake-window",
        targetGeneration: 1,
      } as const;
      const requested = await viewer.operation(lease, action);
      expect(requested.content).toMatchObject({
        status: "error",
        code: "approval-required",
      });
      expect(requested.bytes).toBeNull();
      expect(f.launchCount).toBe(0);
      await approvePending(f);
      expect(f.launchCount).toBe(0);
      expect(f.service.status().sessions).toBe(0);
      const opened = session(await viewer.operation(lease, action));
      expect(f.service.status().sessions).toBe(1);
      const capture = {
        operation: "observation.snapshot",
        sessionId: opened.binding.sessionId,
        targetId: "fake-window",
        targetGeneration: 1,
      } as const;
      expect((await viewer.operation(lease, capture)).content).toMatchObject({
        status: "error",
        code: "approval-required",
      });
      await approvePending(f);
      const snapshot = await viewer.operation(lease, capture);
      expect(snapshot.content.status).toBe("ok");
      expect(pixels(snapshot.bytes!).width).toBe(320);
      snapshot.bytes?.fill(0);
      await viewer.stop(lease);
      expect(f.approvals.status().pending).toBe(0);
    });
  },
);
