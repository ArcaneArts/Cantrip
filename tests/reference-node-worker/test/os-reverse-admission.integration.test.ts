import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { OsTunnelServices } from "../src/os-executor/tunnel-services.js";
import { TunnelWorkerLinkAdapter } from "../src/tunnel-worker-link-adapter.js";
import type { TunnelDestinationRouter } from "../src/tunnel-destination-router.js";
import {
  protectedOsTunnel,
  type Descriptor,
} from "./fixtures/os-protected-tunnel.js";
import { guestPython } from "./fixtures/os-guest-python.js";
const transport: OsExecutorTransport | undefined = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : undefined;
describe.skipIf(!transport)("actual authorized guest listener", () => {
  it("requires a signed listen grant, forwards only after activation, rejects data frames, and closes the real listener on channel retirement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-reverse-admission-"),
    );
    const server = createServer((socket) => socket.end("WORKER HOST PROOF\n"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const hostPort = (server.address() as { port: number }).port,
      port = 51578;
    let services: OsTunnelServices | undefined;
    let channel:
      Awaited<ReturnType<TunnelWorkerLinkAdapter["open"]>> | undefined;
    try {
      const descriptor = await remoteControl<Descriptor>(transport!, [
        "service-info",
        "cua-a",
        "--service",
        JSON.stringify({ kind: "listen", port }),
      ]);
      const f = await protectedOsTunnel(transport!, directory, descriptor, {
        kind: "worker-os-listener",
        port,
        hostPort,
      });
      services = new OsTunnelServices(f.worker, descriptor.worker_id);
      await expect(
        services.prepare({ ...f.prepared, mode: "connect" }),
      ).rejects.toThrow();
      await services.prepare(f.prepared);
      const wrong = structuredClone(f.grant);
      wrong.binding.operations = wrong.binding.operations.map((op) =>
        op === "stream:guest-listen" ? "stream:guest-connect" : op,
      );
      expect(() => services!.activate(wrong, f.session)).toThrow();
      const revokeAttachment = vi.fn();
      const adapter = new TunnelWorkerLinkAdapter(
        { revokeAttachment } as unknown as TunnelDestinationRouter,
        services,
      );
      const input = {
        grant: f.grant,
        session: f.session,
        lane: "stream" as const,
        channel: {
          channelId: crypto.randomUUID(),
          connectionId: crypto.randomUUID(),
        },
        emit: {
          close: vi.fn(async () => true),
          halfClose: () => true,
          error: () => true,
          data: () => true,
        },
      };
      channel = await adapter.open(input);
      await expect(adapter.open(input)).rejects.toThrow();
      await expect(
        Promise.resolve(channel.write?.(Uint8Array.of(0))),
      ).resolves.toBeUndefined();
      expect(() => channel!.write?.(new Uint8Array())).toThrow("heartbeat");
      expect(() => channel!.write?.(Uint8Array.of(1, 2, 3))).toThrow(
        "heartbeat",
      );
      const proof = await guestPython(
        transport!,
        `import socket\nwith socket.create_connection(('127.0.0.1',${port}),timeout=20) as c:\n print(c.recv(128).decode().strip())\n`,
      ).output;
      expect(proof.trim()).toBe("WORKER HOST PROOF");
      await channel.close?.("normal");
      channel = undefined;
      const closed = await guestPython(
        transport!,
        `import socket\ns=socket.socket();s.settimeout(5)\nassert s.connect_ex(('127.0.0.1',${port}))!=0\nprint('retired')\n`,
      ).output;
      expect(closed.trim()).toBe("retired");
      expect(revokeAttachment).toHaveBeenCalledWith(f.attachmentId);
    } finally {
      await channel?.close?.("normal");
      await services?.disconnect();
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
