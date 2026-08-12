import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  unavailableCodeCapabilities,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "../src/config.js";
import {
  loadOrCreateWorkerIdentity,
  loadStoredWorkerCredential,
  saveWorkerCredential,
} from "../src/credential-store.js";
import { enrollWorker } from "../src/enrollment.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-worker-auth-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("worker credential persistence", () => {
  it("keeps a stable identity and server-bound owner-only credential", async () => {
    const directory = await temporaryDirectory();
    const workerId = loadOrCreateWorkerIdentity(directory);
    expect(loadOrCreateWorkerIdentity(directory)).toBe(workerId);

    const credential = `ctwk_${"a".repeat(43)}`;
    saveWorkerCredential({
      credential,
      dataDirectory: directory,
      serverUrl: "https://cantrip.example",
      workerId,
    });
    expect(
      loadStoredWorkerCredential(directory, "https://cantrip.example"),
    ).toMatchObject({ credential, workerId });
    if (process.platform !== "win32") {
      expect(
        (await stat(path.join(directory, "worker-credential.json"))).mode &
          0o777,
      ).toBe(0o600);
    }
    expect(() =>
      loadStoredWorkerCredential(directory, "https://other.example"),
    ).toThrow(/another server/i);
  });

  it("exchanges a link code once and persists only the resulting credential", async () => {
    const directory = await temporaryDirectory();
    const workerId = loadOrCreateWorkerIdentity(directory);
    const credential = `ctwk_${"b".repeat(43)}`;
    const heartbeat: WorkerHeartbeat = {
      workerId,
      name: "Desk Mac",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: null,
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      code: unavailableCodeCapabilities,
      startedAt: "2026-08-11T12:00:00.000Z",
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          credential,
          credentialSummary: {
            id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
            workerId,
            label: null,
            scopes: [
              "worker:connect",
              "worker:heartbeat",
              "worker:automations",
              "worker:agent-tools",
            ],
            createdAt: "2026-08-11T12:00:00.000Z",
            expiresAt: null,
            lastUsedAt: "2026-08-11T12:00:00.000Z",
            revokedAt: null,
            revokedReason: null,
            active: true,
          },
          worker: {
            ...heartbeat,
            online: true,
            lastSeenAt: heartbeat.startedAt,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const config = {
      dataDirectory: directory,
      enrollmentCode: `ctwl_${"c".repeat(32)}`,
      serverUrl: "https://cantrip.example",
      token: "",
      tokenSource: "enrollment",
      workerId,
    } as WorkerConfig;

    await enrollWorker(config, heartbeat);

    expect(config).toMatchObject({
      enrollmentCode: null,
      token: credential,
      tokenSource: "persisted",
    });
    expect(
      loadStoredWorkerCredential(directory, config.serverUrl),
    ).toMatchObject({ credential, workerId });
    expect(JSON.stringify(fetch.mock.calls[0]?.[1])).toContain(
      `ctwl_${"c".repeat(32)}`,
    );
  });
});
