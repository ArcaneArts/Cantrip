import { createServer } from "node:http";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  remoteBrowserClipboardMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  type RemoteSurfaceChannel,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserRemoteSurfaceAdapter } from "../src/browser/browser-adapter.js";
import { findChromiumExecutable } from "../src/browser/chromium.js";

const temporaryDirectories: string[] = [];

async function eventually(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for the worker browser.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
      const command = {
        type: "surface.attach" as const,
        surfaceId: "browser-adoption-test",
        attachmentId: "first-attachment",
        projectId: "project-test",
        configuration: {
          kind: "browser" as const,
          initialUrl: root,
          profileId: null,
        },
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
    },
    30_000,
  );

  it.skipIf(!findChromiumExecutable())(
    "streams a real Chromium page and accepts worker-side navigation",
    async () => {
      const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<title>${request.url === "/next" ? "Next" : "Home"}</title><style>body{margin:0}a{display:block;height:100px;cursor:pointer}</style><a id="target">Cantrip browser</a><textarea id="input"></textarea>`,
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
      const session = await adapter.open(
        {
          type: "surface.attach",
          surfaceId: "browser-test",
          attachmentId: "attachment-test",
          projectId: "project-test",
          configuration: {
            kind: "browser",
            initialUrl: root,
            profileId: null,
          },
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

        await session.handleFrame(
          "attachment-test",
          "control",
          new TextEncoder().encode(
            JSON.stringify({ type: "navigate", url: `${root}next` }),
          ),
        );
        await eventually(() =>
          emissions
            .filter(({ channel }) => channel === "control")
            .some(({ payload }) => {
              const state = remoteBrowserServerMessageSchema.parse(
                JSON.parse(new TextDecoder().decode(payload)),
              );
              return (
                state.type === "browser-state" &&
                state.url === `${root}next` &&
                state.title === "Next"
              );
            }),
        );
        await eventually(
          () =>
            emissions.filter(({ channel }) => channel === "frame").length >
            framesBeforeNavigation,
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
          emissions
            .filter(({ channel }) => channel === "control")
            .some(({ payload }) => {
              const state = remoteBrowserServerMessageSchema.parse(
                JSON.parse(new TextDecoder().decode(payload)),
              );
              return (
                state.type === "browser-state" && state.url === `${root}next`
              );
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
