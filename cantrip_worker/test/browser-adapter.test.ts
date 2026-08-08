import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
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
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("BrowserRemoteSurfaceAdapter", () => {
  it.skipIf(!findChromiumExecutable())(
    "streams a real Chromium page and accepts worker-side navigation",
    async () => {
      const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<title>${request.url === "/next" ? "Next" : "Home"}</title><main>Cantrip browser</main>`,
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
      const adapter = new BrowserRemoteSurfaceAdapter({ dataDirectory });
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
        },
        (attachmentId, channel, payload) =>
          emissions.push({ attachmentId, channel, payload }),
      );
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
              return state.url === `${root}next` && state.title === "Next";
            }),
        );
        await eventually(
          () =>
            emissions.filter(({ channel }) => channel === "frame").length >
            framesBeforeNavigation,
        );
      } finally {
        await session.close();
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
