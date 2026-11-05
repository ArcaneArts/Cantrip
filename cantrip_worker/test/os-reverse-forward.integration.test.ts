import { guestPython } from "./fixtures/os-guest-python.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { OsServiceStream } from "../src/os-executor/service-stream.js";
import { OsReverseForward } from "../src/os-executor/reverse-forward.js";

const transport: OsExecutorTransport | undefined = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : undefined;
const guestPort = 51577;
const guest = (script: string) => guestPython(transport!, script);
async function listener(overrides: Record<string, unknown> = {}) {
  const descriptor = await remoteControl<Record<string, unknown>>(transport!, [
    "service-info",
    "cua-a",
    "--service",
    JSON.stringify({ kind: "listen", port: guestPort }),
  ]);
  expect(descriptor.desktop_generation).toBeUndefined();
  const stream = new OsServiceStream(transport!, "cua-a", {
    ...descriptor,
    ...overrides,
  });
  try {
    await stream.ready();
    return stream;
  } catch (error) {
    // Expected admission failures must finish actual guest retirement before
    // the next fixture connection starts, including its SSH control carrier.
    await stream.confirmRetired();
    throw error;
  }
}

describe.skipIf(!transport)(
  "actual Guest-to-Worker-host forwarding carrier",
  () => {
    it("multiplexes two real >1MiB binary half-closed clients into the explicit Host service while the desktop is stopped", async () => {
      const sockets = new Set<Socket>(),
        errors: unknown[] = [];
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        const chunks: Buffer[] = [];
        let size = 0;
        socket.on("error", (e) => errors.push(e));
        socket.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024)
            socket.destroy(new Error("Fixture request exceeded its bound."));
          else chunks.push(chunk);
        });
        socket.once("end", () => {
          const body = Buffer.concat(chunks);
          socket.end(
            Buffer.concat([
              Buffer.from("WORKER HOST\n"),
              Buffer.from(body).reverse(),
              createHash("sha256").update(body).digest(),
            ]),
          );
        });
        socket.once("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      let stream: OsServiceStream | undefined,
        forward: OsReverseForward | undefined;
      try {
        await guest(
          "import subprocess\nsubprocess.run(['cantrip-workspaces','stop','cua-a'],check=True,capture_output=True)\n",
        ).output;
        stream = await listener();
        await expect(listener()).rejects.toThrow(/readiness receipt/u);
        await expect(listener({ owner_id: "another-owner" })).rejects.toThrow(
          /readiness receipt/u,
        );
        forward = new OsReverseForward(stream, { host: "127.0.0.1", port });
        const proof = await guest(`import socket,threading,hashlib,json
payload=bytes(range(256))*4096+b'Cantrip reverse proof'
results=[];errors=[]
def client():
 try:
  with socket.create_connection(('127.0.0.1',${guestPort}),timeout=30) as c:
   c.settimeout(30);c.sendall(payload);c.shutdown(socket.SHUT_WR)
   reply=bytearray()
   while True:
    data=c.recv(65536)
    if not data:break
    reply.extend(data)
   assert reply==b'WORKER HOST\\n'+payload[::-1]+hashlib.sha256(payload).digest(),(len(reply),len(payload))
   results.append(len(reply))
 except BaseException as e:errors.append(repr(e))
threads=[threading.Thread(target=client) for _ in range(2)]
for t in threads:t.start()
for t in threads:t.join(40)
assert not errors and len(results)==2,(errors,results)
print(json.dumps({'clients':len(results),'reply_bytes':results}),flush=True)
`).output;
        expect(JSON.parse(proof).clients).toBe(2);
        expect(errors).toEqual([]);
        expect(forward.stats.opened).toBe(2);
        expect(forward.stats.fromGuest).toBeGreaterThan(2 * 1024 * 1024);
        expect(forward.stats.toGuest).toBeGreaterThan(2 * 1024 * 1024);
        expect(forward.error).toBeNull();
        forward.close();
        await forward.closed;
        await stream.confirmRetired();
        await guest(`import socket
try:
 c=socket.create_connection(('127.0.0.1',${guestPort}),timeout=5)
except ConnectionRefusedError:pass
else:c.close();raise AssertionError('Retired guest listener still accepts clients')
`).output;
      } finally {
        forward?.close();
        stream?.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await remoteControl(transport!, ["open", "cua-a"]);
      }
    }, 150_000);

    it.each(["revoke", "manager-restart", "manager-death", "disable"])(
      "closes actual idle Guest and Host sockets on %s",
      async (retirement) => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let stream: OsServiceStream | undefined,
          forward: OsReverseForward | undefined;
        let client: ReturnType<typeof guest> | undefined;
        try {
          stream = await listener();
          forward = new OsReverseForward(stream, {
            host: "127.0.0.1",
            port: (server.address() as { port: number }).port,
          });
          client = guest(`import socket
with socket.create_connection(('127.0.0.1',${guestPort}),timeout=30) as c:
 c.settimeout(30);print('READY',flush=True)
 assert c.recv(1)==b''
print('CLOSED',flush=True)
`);
          await once(client.child.stdout, "data");
          await expect.poll(() => sockets.size).toBe(1);
          if (retirement === "manager-restart") {
            const command = remoteCommand(transport!, ["service", "restart"]);
            await promisify(execFile)(command.command, command.args, {
              timeout: 90_000,
            });
          } else if (retirement === "manager-death") {
            await guest(`import socket,struct,os,signal
with socket.socket(socket.AF_UNIX) as c:
 c.connect('/run/cantrip-os-remote/control.sock')
 pid,uid,_=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
 assert uid==0
 fd=os.pidfd_open(pid)
 try:signal.pidfd_send_signal(fd,signal.SIGKILL)
 finally:os.close(fd)
`).output;
          } else if (retirement === "disable") {
            const command = remoteCommand(transport!, ["disable"]);
            await promisify(execFile)(command.command, command.args, {
              timeout: 90_000,
            });
          } else forward.close();
          await forward.closed;
          expect(await client.output).toContain("CLOSED");
          await expect.poll(() => sockets.size).toBe(0);
          expect(forward.stats.closed).toBe(forward.stats.opened);
          if (retirement === "revoke") await stream.confirmRetired();
          else await expect(stream.confirmRetired()).rejects.toThrow();
        } finally {
          client?.child.kill();
          forward?.close();
          stream?.destroy();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          if (retirement === "manager-death" || retirement === "disable") {
            const command = remoteCommand(
              transport!,
              retirement === "disable" ? ["enable"] : ["service", "start"],
            );
            await promisify(execFile)(command.command, command.args, {
              timeout: 90_000,
            });
          }
        }
      },
      150_000,
    );
  },
);
