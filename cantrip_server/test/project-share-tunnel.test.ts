import type { AddressInfo } from "node:net";

import type {
  CodeTunnelFrameHeader,
  ProjectShareTunnelFrameHeader,
  RemoteSurfaceFrameHeader,
  WorkerCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeCodeSurfaceServer,
  CodeTunnelBroker,
  createCodeSurfaceServer,
} from "../src/code/tunnel.js";
import { ProjectShareTunnelBroker } from "../src/project-shares/tunnel.js";
import type {
  WorkerCodeTunnelFrameListener,
  WorkerCommandBus,
  WorkerProjectShareTunnelFrameListener,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
} from "../src/workers/bridge.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface ObservedRequest {
  body: Buffer;
  header: Extract<
    ProjectShareTunnelFrameHeader,
    { kind: "http-request-start" }
  >;
}

class LoopbackProjectShareWorker implements WorkerCommandBus {
  readonly closedShareIds: string[] = [];
  readonly observedRequests: ObservedRequest[] = [];
  readonly openedShareIds: string[] = [];
  readonly #listeners = new Set<WorkerProjectShareTunnelFrameListener>();
  readonly #requests = new Map<
    string,
    {
      chunks: Buffer[];
      header: Extract<
        ProjectShareTunnelFrameHeader,
        { kind: "http-request-start" }
      >;
    }
  >();

  attach(): void {}
  close(): void {}
  isConnected(workerId: string): boolean {
    return workerId === "worker-1";
  }
  sendSurfaceFrame(
    _workerId: string,
    _header: RemoteSurfaceFrameHeader,
    _payload: Uint8Array,
  ): boolean {
    return false;
  }
  subscribeSurfaceFrames(
    _workerId: string,
    _listener: WorkerSurfaceFrameListener,
  ): () => void {
    return () => undefined;
  }
  subscribeCodeTunnelFrames(
    _workerId: string,
    _listener: WorkerCodeTunnelFrameListener,
  ): () => void {
    return () => undefined;
  }
  sendCodeTunnelFrame(
    _workerId: string,
    _header: CodeTunnelFrameHeader,
    _payload: Uint8Array,
  ): boolean {
    return false;
  }
  subscribeWorkerDisconnect(): () => void {
    return () => undefined;
  }
  subscribeProjectShareTunnelFrames(
    _workerId: string,
    listener: WorkerProjectShareTunnelFrameListener,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  sendProjectShareTunnelFrame(
    _workerId: string,
    header: ProjectShareTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const key = `${header.shareId}\0${header.streamId}`;
    if (header.kind === "http-request-start") {
      this.#requests.set(key, { chunks: [], header });
      return true;
    }
    const request = this.#requests.get(key);
    if (!request) return true;
    if (header.kind === "http-request-data") {
      request.chunks.push(Buffer.from(payload));
      return true;
    }
    if (header.kind !== "http-request-end") return true;
    this.#requests.delete(key);
    this.observedRequests.push({
      body: Buffer.concat(request.chunks),
      header: request.header,
    });
    const authorized = request.header.headers.some(
      ([name, value]) =>
        name.toLowerCase() === "authorization" && value.startsWith("Digest "),
    );
    queueMicrotask(() => {
      const base = {
        protocolVersion: 1 as const,
        shareId: header.shareId,
        streamId: header.streamId,
      };
      this.#emit(
        {
          ...base,
          kind: "http-response-start",
          statusCode: authorized ? 207 : 401,
          headers: authorized
            ? [
                ["Content-Type", "application/xml"],
                ["DAV", "1, 2"],
                ["Set-Cookie", "worker-secret=must-not-leave"],
              ]
            : [
                [
                  "WWW-Authenticate",
                  'Digest realm="Cantrip Project Share", qop="auth", nonce="nonce"',
                ],
              ],
        },
        new Uint8Array(),
      );
      if (authorized) {
        this.#emit(
          { ...base, kind: "http-response-data" },
          new TextEncoder().encode("<multistatus>README.md</multistatus>"),
        );
      }
      this.#emit({ ...base, kind: "http-response-end" }, new Uint8Array());
    });
    return true;
  }
  request(
    workerId: string,
    command: WorkerCommand,
    _options?: WorkerRequestOptions,
  ): Promise<unknown> {
    if (workerId !== "worker-1") return Promise.reject(new Error("offline"));
    if (command.type === "project.share.open") {
      this.openedShareIds.push(command.shareId);
      return Promise.resolve({
        shareId: command.shareId,
        protocol: "webdav",
        publicBasePath: command.publicBasePath,
        publicOrigin: command.publicOrigin,
        loopbackHost: "127.0.0.1",
        loopbackPort: 43_210,
        username: "cantrip-worker-user",
        password: "a-strong-random-worker-password",
        realm: "Cantrip Project Share",
      });
    }
    if (command.type === "project.share.close") {
      this.closedShareIds.push(command.shareId);
      return Promise.resolve({ accepted: true });
    }
    return Promise.reject(new Error(`Unexpected command ${command.type}`));
  }

  #emit(header: ProjectShareTunnelFrameHeader, payload: Uint8Array): void {
    for (const listener of this.#listeners) listener(header, payload);
  }
}

describe("project share server tunnel", () => {
  it("opens, reuses, proxies, and revokes authenticated WebDAV attachments", async () => {
    const worker = new LoopbackProjectShareWorker();
    const surfaceOrigin = "http://127.0.0.1:4311";
    const code = new CodeTunnelBroker(worker, {
      allowedFrameAncestors: ["tauri://localhost"],
      surfaceOrigin,
    });
    const shares = new ProjectShareTunnelBroker(worker, { surfaceOrigin });
    const [attachment, reused] = await Promise.all(
      ["first", "second"].map(() =>
        shares.open({
          ownerId: "user-1",
          projectId: "project-1",
          root: "/worker/projects/cantrip",
          workerId: "worker-1",
        }),
      ),
    );
    expect(reused.attachmentId).toBe(attachment.attachmentId);
    expect(worker.openedShareIds).toEqual([attachment.attachmentId]);
    expect(attachment.url).not.toContain("127.0.0.1:43210");
    expect(attachment.password).toBe("a-strong-random-worker-password");

    const surface = createCodeSurfaceServer(code, surfaceOrigin, shares);
    await new Promise<void>((resolve) =>
      surface.listen(0, "127.0.0.1", resolve),
    );
    closers.push(() => closeCodeSurfaceServer(surface));
    closers.push(async () => {
      await shares.close();
      code.close();
    });
    const { port } = surface.address() as AddressInfo;
    const attachmentPath = new URL(attachment.url).pathname;

    const challenge = await fetch(`http://127.0.0.1:${port}${attachmentPath}`, {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      "Cantrip Project Share",
    );

    const authorized = await fetch(
      `http://127.0.0.1:${port}${attachmentPath}README.md`,
      {
        method: "PROPFIND",
        headers: {
          Authorization: 'Digest username="cantrip-worker-user"',
          Depth: "1",
          Destination: `${attachment.url}moved.md`,
        },
      },
    );
    expect(authorized.status).toBe(207);
    expect(await authorized.text()).toContain("README.md");
    expect(authorized.headers.get("dav")).toBe("1, 2");
    expect(authorized.headers.get("set-cookie")).toBeNull();
    expect(worker.observedRequests.at(-1)?.header).toMatchObject({
      method: "PROPFIND",
      path: `${attachmentPath}README.md`,
    });
    expect(
      worker.observedRequests
        .at(-1)
        ?.header.headers.map(([name, value]) => [name.toLowerCase(), value]),
    ).toEqual(
      expect.arrayContaining([
        ["authorization", 'Digest username="cantrip-worker-user"'],
        ["destination", `${attachment.url}moved.md`],
      ]),
    );

    expect(
      await shares.revokeAttachment(attachment.attachmentId, "user-2"),
    ).toBe(false);
    expect(
      await shares.revokeAttachment(attachment.attachmentId, "user-1"),
    ).toBe(true);
    expect(worker.closedShareIds).toEqual([attachment.attachmentId]);
    expect(
      await fetch(`http://127.0.0.1:${port}${attachmentPath}`).then(
        (response) => response.status,
      ),
    ).toBe(404);
  });

  it("expires idle attachments and closes their worker shares", async () => {
    const worker = new LoopbackProjectShareWorker();
    const shares = new ProjectShareTunnelBroker(worker, {
      idleTtlMs: 1,
      maxLifetimeMs: 100,
      surfaceOrigin: "https://surface.cantrip.example",
    });
    closers.push(() => shares.close());
    const attachment = await shares.open({
      ownerId: "user-1",
      projectId: "project-1",
      root: "/worker/projects/cantrip",
      workerId: "worker-1",
    });
    const token = new URL(attachment.url).pathname.split("/")[2]!;

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(shares.hasAttachment(token)).toBe(false);
    await expect
      .poll(() => worker.closedShareIds)
      .toEqual([attachment.attachmentId]);
  });
});
