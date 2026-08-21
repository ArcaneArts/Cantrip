import { createServer } from "node:http";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  remoteBrowserClipboardMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  type RemoteSurfaceChannel,
} from "@cantrip/protocol";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserRemoteSurfaceAdapter } from "../src/browser/browser-adapter.js";
import { findChromiumExecutable } from "../src/browser/chromium.js";
import { readWorkerLogs } from "../src/logger.js";
import {
  decodeSurfacePrivateStateForWorker,
  encodeSurfacePrivateStateForWorker,
} from "../src/surface-private-state-encryption.js";
import { WorkerEncryptionService } from "../src/worker-encryption.js";

const temporaryDirectories: string[] = [];

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for the worker browser.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ownerId = "browser-adapter-owner";
const serverId = "https://browser-adapter.test";
const workerId = "browser-adapter-worker";
const timestamp = "2026-08-20T12:00:00.000Z";

async function encryptionService(
  dataDirectory: string,
): Promise<WorkerEncryptionService> {
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId,
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Browser adapter worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "surface-private-state",
    keyRevision: 1,
  });
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "surface-private-state",
    componentKey,
    keyRevision: 1,
    workerPublicKey: principal.publicKey,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "surface-private-state",
    keyRevision: 1,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await service.acceptBootstrap({ ownerId, principal, grants: [grant] });
  return service;
}

function persistentBrowserState(input: {
  revision: number;
  service: WorkerEncryptionService;
  surfaceId: string;
  url: string;
}) {
  return encodeSurfacePrivateStateForWorker({
    ownerId,
    context: {
      serverId,
      resource: "browser-row",
      resourceId: input.surfaceId,
      operationId: null,
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: input.revision,
      url: input.url,
    },
    service: input.service,
  });
}

function navigationBrowserState(input: {
  operationId: string;
  revision: number;
  service: WorkerEncryptionService;
  surfaceId: string;
  url: string;
}) {
  return encodeSurfacePrivateStateForWorker({
    ownerId,
    context: {
      serverId,
      resource: "browser-operation",
      resourceId: input.surfaceId,
      operationId: input.operationId,
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: input.revision,
      url: input.url,
    },
    service: input.service,
  });
}

async function hasBrowserState(input: {
  emissions: Array<{ channel: RemoteSurfaceChannel; payload: Uint8Array }>;
  revision: number;
  service: WorkerEncryptionService;
  surfaceId: string;
  title?: string;
  url: string;
}): Promise<boolean> {
  for (const { channel, payload } of input.emissions) {
    if (channel !== "control") continue;
    const state = remoteBrowserServerMessageSchema.parse(
      JSON.parse(new TextDecoder().decode(payload)),
    );
    if (state.type !== "browser-state") continue;
    try {
      const opened = await decodeSurfacePrivateStateForWorker({
        ownerId,
        context: {
          serverId,
          resource: "browser-operation",
          resourceId: input.surfaceId,
          operationId: state.operationId,
          recordKind: "browser-state",
        },
        opaque: state.stateProtection,
        service: input.service,
      });
      if (
        opened.revision === input.revision &&
        opened.url === input.url &&
        (input.title === undefined || state.title === input.title)
      ) {
        return true;
      }
    } catch {
      // Ignore frames from another operation while waiting for the target state.
    }
  }
  return false;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

describe("BrowserRemoteSurfaceAdapter", () => {
  it.skipIf(!findChromiumExecutable())(
    "adopts an active Cantrip browser profile instead of relaunching it",
    async () => {
      const afterCursor = readWorkerLogs({
        afterCursor: 0,
        limit: 200,
        minimumLevel: "trace",
      }).latestCursor;
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end("<title>Adopted</title><p>Still running</p>");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test browser server did not expose a TCP address.");
      }
      const root = `http://127.0.0.1:${address.port}/`;
      const dataDirectory = await mkdtemp(
        path.join(os.tmpdir(), "cantrip-browser-adoption-"),
      );
      temporaryDirectories.push(dataDirectory);
      const firstLaunches: ChildProcess[] = [];
      const adoptedLaunches: ChildProcess[] = [];
      const firstAdapter = new BrowserRemoteSurfaceAdapter({
        dataDirectory,
        onLaunch: (process) => firstLaunches.push(process),
      });
      const adoptedAdapter = new BrowserRemoteSurfaceAdapter({
        dataDirectory,
        onLaunch: (process) => adoptedLaunches.push(process),
      });
      const surfacePrivateState = await encryptionService(dataDirectory);
      firstAdapter.setSurfacePrivateStateService(surfacePrivateState);
      adoptedAdapter.setSurfacePrivateStateService(surfacePrivateState);
      const surfaceId = "browser-adoption-test";
      const command = {
        type: "surface.attach" as const,
        surfaceId,
        attachmentId: "first-attachment",
        projectId: "project-test",
        serverId,
        configuration: {
          kind: "browser" as const,
          profileId: null,
        },
        stateResource: "browser-row" as const,
        stateRevision: 1,
        stateProtection: await persistentBrowserState({
          revision: 1,
          service: surfacePrivateState,
          surfaceId,
          url: root,
        }),
        preferredTransport: "websocket" as const,
        viewport: { width: 640, height: 480, devicePixelRatio: 1 },
        desktopStream: null,
      };
      const firstSession = await firstAdapter.open(command, () => true);
      const emissions: Array<{
        attachmentId: string;
        channel: RemoteSurfaceChannel;
      }> = [];
      let adoptedSession: Awaited<
        ReturnType<BrowserRemoteSurfaceAdapter["open"]>
      > | null = null;

      try {
        await firstSession.attach({
          id: "first-attachment",
          viewport: command.viewport,
        });
        expect(firstLaunches).toHaveLength(1);

        adoptedSession = await adoptedAdapter.open(
          { ...command, attachmentId: "adopted-attachment" },
          (attachmentId, channel) => {
            emissions.push({ attachmentId, channel });
            return true;
          },
        );
        await adoptedSession.attach({
          id: "adopted-attachment",
          viewport: command.viewport,
        });
        await eventually(() =>
          emissions.some(
            ({ attachmentId, channel }) =>
              attachmentId === "adopted-attachment" && channel === "frame",
          ),
        );

        expect(adoptedLaunches).toHaveLength(0);
        expect(adoptedAdapter.session(command.surfaceId)).not.toBeNull();
      } finally {
        await adoptedSession?.close();
        await firstSession.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const serializedLogs = JSON.stringify(
        readWorkerLogs({
          afterCursor,
          limit: 200,
          minimumLevel: "trace",
        }).records,
      );
      expect(serializedLogs).toContain("browser.runtime.ready");
      expect(serializedLogs).not.toContain(root);
      expect(serializedLogs).not.toContain("Adopted");
    },
    30_000,
  );

  it.skipIf(!findChromiumExecutable())(
    "streams a real Chromium page and accepts worker-side navigation",
    async () => {
      const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<title>${request.url === "/next" ? "Next" : request.url === "/configured" ? "Configured" : "Home"}</title><style>body{margin:0;min-height:2400px}a{display:block;height:100px;cursor:pointer}</style><a id="target">Cantrip browser</a><textarea id="input"></textarea>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test browser server did not expose a TCP address.");
      }
      const root = `http://127.0.0.1:${address.port}/`;
      const dataDirectory = await mkdtemp(
        path.join(os.tmpdir(), "cantrip-browser-adapter-"),
      );
      temporaryDirectories.push(dataDirectory);
      const emissions: Array<{
        attachmentId: string;
        channel: RemoteSurfaceChannel;
        payload: Uint8Array;
      }> = [];
      const launches: ChildProcess[] = [];
      const adapter = new BrowserRemoteSurfaceAdapter({
        dataDirectory,
        onLaunch: (process) => launches.push(process),
      });
      const surfacePrivateState = await encryptionService(dataDirectory);
      adapter.setSurfacePrivateStateService(surfacePrivateState);
      const surfaceId = "browser-test";
      const session = await adapter.open(
        {
          type: "surface.attach",
          surfaceId,
          attachmentId: "attachment-test",
          projectId: "project-test",
          serverId,
          configuration: {
            kind: "browser",
            profileId: null,
          },
          stateResource: "browser-row",
          stateRevision: 1,
          stateProtection: await persistentBrowserState({
            revision: 1,
            service: surfacePrivateState,
            surfaceId,
            url: root,
          }),
          preferredTransport: "websocket",
          viewport: { width: 640, height: 480, devicePixelRatio: 1 },
          desktopStream: null,
        },
        (attachmentId, channel, payload) => {
          emissions.push({ attachmentId, channel, payload });
          return true;
        },
      );
      expect(adapter.session("browser-test")).not.toBeNull();
      try {
        await session.attach({
          id: "attachment-test",
          viewport: { width: 640, height: 480, devicePixelRatio: 1 },
        });
        await eventually(
          () =>
            emissions.some(({ channel }) => channel === "frame") &&
            emissions.some(({ channel }) => channel === "control"),
        );
        const framesBeforeNavigation = emissions.filter(
          ({ channel }) => channel === "frame",
        ).length;

        const navigationOperationId = crypto.randomUUID();
        await session.handleFrame(
          "attachment-test",
          "control",
          new TextEncoder().encode(
            JSON.stringify({
              type: "navigate",
              operationId: navigationOperationId,
              stateProtection: await navigationBrowserState({
                operationId: navigationOperationId,
                revision: 1,
                service: surfacePrivateState,
                surfaceId,
                url: `${root}next`,
              }),
            }),
          ),
        );
        await eventually(() =>
          hasBrowserState({
            emissions,
            revision: 1,
            service: surfacePrivateState,
            surfaceId,
            title: "Next",
            url: `${root}next`,
          }),
        );
        await eventually(
          () =>
            emissions.filter(({ channel }) => channel === "frame").length >
            framesBeforeNavigation,
        );

        await session.updateConfiguration?.(
          { kind: "browser", profileId: null },
          {
            serverId,
            stateResource: "browser-row",
            stateRevision: 2,
            stateProtection: await persistentBrowserState({
              revision: 2,
              service: surfacePrivateState,
              surfaceId,
              url: `${root}configured`,
            }),
          },
        );
        await eventually(() =>
          hasBrowserState({
            emissions,
            revision: 2,
            service: surfacePrivateState,
            surfaceId,
            title: "Configured",
            url: `${root}configured`,
          }),
        );

        await session.handleFrame(
          "attachment-test",
          "control",
          new TextEncoder().encode(
            JSON.stringify({
              type: "pointer",
              event: "move",
              x: 10,
              y: 10,
            }),
          ),
        );
        await eventually(() =>
          emissions
            .filter(({ channel }) => channel === "cursor")
            .some(
              ({ payload }) =>
                remoteBrowserCursorMessageSchema.parse(
                  JSON.parse(new TextDecoder().decode(payload)),
                ).cursor === "pointer",
            ),
        );

        await adapter
          .session("browser-test")
          ?.evaluate(
            `(() => { const selection = getSelection(); selection.removeAllRanges(); const range = document.createRange(); range.selectNodeContents(document.querySelector('#target')); selection.addRange(range); })()`,
          );
        await session.handleFrame(
          "attachment-test",
          "control",
          new TextEncoder().encode(
            JSON.stringify({
              type: "clipboard",
              operation: "copy-selection",
            }),
          ),
        );
        await eventually(() =>
          emissions
            .filter(({ channel }) => channel === "clipboard")
            .some(
              ({ payload }) =>
                remoteBrowserClipboardMessageSchema.parse(
                  JSON.parse(new TextDecoder().decode(payload)),
                ).text === "Cantrip browser",
            ),
        );
        await adapter
          .session("browser-test")
          ?.evaluate("document.querySelector('#input').focus()");
        await session.handleFrame(
          "attachment-test",
          "control",
          new TextEncoder().encode(
            JSON.stringify({
              type: "clipboard",
              operation: "paste-text",
              text: "pasted",
            }),
          ),
        );
        await expect(
          adapter
            .session("browser-test")
            ?.evaluate("document.querySelector('#input').value"),
        ).resolves.toBe("pasted");

        await expect(
          session.handleFrame(
            "attachment-test",
            "control",
            new TextEncoder().encode(
              JSON.stringify({
                type: "touch",
                event: "end",
                points: [{ id: 1, x: 320, y: 400 }],
              }),
            ),
          ),
        ).rejects.toThrow(/CDP/);
        expect(adapter.session("browser-test")).not.toBeNull();
        expect(launches).toHaveLength(1);

        for (const message of [
          {
            type: "touch",
            event: "start",
            points: [{ id: 1, x: 320, y: 400 }],
          },
          {
            type: "touch",
            event: "move",
            points: [{ id: 1, x: 320, y: 100 }],
          },
          { type: "touch", event: "end", points: [] },
        ]) {
          await session.handleFrame(
            "attachment-test",
            "control",
            new TextEncoder().encode(JSON.stringify(message)),
          );
        }
        await eventually(async () =>
          Boolean(
            await adapter
              .session("browser-test")
              ?.evaluate("globalThis.scrollY > 0"),
          ),
        );
        expect(launches).toHaveLength(1);

        const framesBeforeCrash = emissions.filter(
          ({ channel }) => channel === "frame",
        ).length;
        launches[0]?.kill("SIGKILL");
        await eventually(() =>
          emissions
            .filter(({ channel }) => channel === "control")
            .some(({ payload }) => {
              const state = remoteBrowserServerMessageSchema.parse(
                JSON.parse(new TextDecoder().decode(payload)),
              );
              return (
                state.type === "browser-runtime" &&
                state.status === "recovering"
              );
            }),
        );
        await eventually(() => launches.length >= 2);
        await eventually(
          () =>
            emissions.filter(({ channel }) => channel === "frame").length >
            framesBeforeCrash,
          20_000,
        );
        await eventually(() =>
          hasBrowserState({
            emissions,
            revision: 2,
            service: surfacePrivateState,
            surfaceId,
            url: `${root}configured`,
          }),
        );
      } finally {
        await session.close();
        expect(adapter.session("browser-test")).toBeNull();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      expect(
        emissions.some(
          ({ attachmentId, channel, payload }) =>
            attachmentId === "attachment-test" &&
            channel === "frame" &&
            payload.byteLength > 100,
        ),
      ).toBe(true);
    },
    30_000,
  );
});
