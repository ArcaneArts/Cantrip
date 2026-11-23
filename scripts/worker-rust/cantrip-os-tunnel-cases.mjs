// Core and the native worker reach owned services through the guest broker.
// The fixture guest has no host network access.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { encryptEndpointContentPayload } from "../../packages/crypto/dist/index.js";
import { openTunnelDataFrame } from "../../tests/reference-node-worker/src/tunnel-data-protection.ts";
import { Connection } from "./worker-link-tunnel-cases.mjs";
import { ownerId } from "./cantrip-os-grant.mjs";

const execute = promisify(execFile);

export async function verifyCantripOsTunnel(options) {
  const { docker, container, actual, eventually } = options;
  const ready = actual.home + "/cantrip-tunnel-fixture-" + randomUUID();
  const guest = (...args) =>
    docker("exec", "--user", String(actual.uid), container, ...args);
  await docker(
    "exec",
    "--detach",
    "--user",
    String(actual.uid),
    container,
    "python3",
    "-c",
    `
import pathlib, socket, sys
from contextlib import closing
ready = pathlib.Path(sys.argv[1])
with closing(socket.socket()) as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(2)
    listener.settimeout(60)
    ready.write_text(str(listener.getsockname()[1]))
    for count in range(2):
        service, _ = listener.accept()
        with closing(service):
            try:
                payload = b"".join(iter(lambda: service.recv(65536), b""))
                if payload:
                    service.sendall(b"guest:" + payload)
            except ConnectionError:
                pass
        ready.with_suffix(".closed").write_text(str(count + 1))
`,
    ready,
  );
  const port = await eventually(async () => {
    const value = Number(await guest("cat", ready));
    assert.ok(Number.isInteger(value) && value > 0);
    return value;
  });

  const { connection, configuration, route, protectedRecord, revoke } =
    await attachTunnel(options, "tcp", { kind: "worker-os-tcp", port });
  try {
    const wrong = connection.stream(route, {
      ...route.target,
      protectedRecord: { ...protectedRecord, operationId: randomUUID() },
    });
    assert.equal(
      (await wrong.next("rejected")).header.code,
      "protected-target-invalid",
    );

    const stream = connection.stream(route, undefined, 65536);
    await stream.next("accepted");
    const request = Buffer.from("private guest fixture " + randomUUID());
    stream.send(
      { kind: "data", direction: "source-to-destination" },
      request,
      configuration,
    );
    stream.send({ kind: "half-close", direction: "source-to-destination" });
    const chunks = [];
    for (;;) {
      const { header, payload } = await stream.next("data", "half-close");
      if (header.kind === "half-close") break;
      chunks.push(openTunnelDataFrame(configuration, header, payload));
    }
    assert.deepEqual(
      Buffer.concat(chunks),
      Buffer.concat([Buffer.from("guest:"), request]),
    );

    const held = connection.stream(route);
    await held.next("accepted");
    await revoke();
    await connection.nextControl("close");
    await eventually(async () => {
      assert.equal(await guest("cat", ready + ".closed"), "2");
    });
  } finally {
    connection.socket.terminate();
  }
}

export async function verifyCantripOsSsh(options) {
  const { docker, container, actual, eventually } = options;
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-native-ssh-"));
  const sockets = new Set();
  let forward, listener, idle, exited;
  try {
    const key = path.join(directory, "client");
    const other = path.join(directory, "other");
    for (const file of [key, other]) {
      await execute("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        file,
      ]);
    }
    const publicKey = (await readFile(key + ".pub", "utf8"))
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .join(" ");
    forward = await attachTunnel(options, "ssh", {
      kind: "worker-os-ssh",
      publicKey,
    });
    assert.ok(!JSON.stringify(forward.protectedRecord).includes(publicKey));
    const descriptor = JSON.parse(
      await docker(
        "exec",
        "--user",
        "0",
        container,
        "/usr/bin/cantrip-remote",
        "service-info",
        actual.id,
        "--service",
        '{"kind":"ssh"}',
      ),
    );
    assert.deepEqual(forward.ssh, {
      user: descriptor.user,
      hostAlias: `cantrip-os-${descriptor.instance_id}`,
      hostKey: descriptor.ssh_host_key,
    });
    const known = path.join(directory, "known_hosts");
    await writeFile(
      known,
      `${forward.ssh.hostAlias} ${forward.ssh.hostKey}\n`,
      {
        mode: 0o600,
      },
    );
    listener = createServer(
      { allowHalfOpen: true, pauseOnConnect: true },
      (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        void relaySsh(socket, forward).catch((error) => socket.destroy(error));
      },
    );
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = String(listener.address().port);
    const target = `${forward.ssh.user}@127.0.0.1`;
    const flags = [
      "-F",
      "/dev/null",
      "-oBatchMode=yes",
      "-oConnectTimeout=10",
      "-oStrictHostKeyChecking=yes",
      `-oUserKnownHostsFile=${known}`,
      `-oHostKeyAlias=${forward.ssh.hostAlias}`,
      "-oIdentitiesOnly=yes",
    ];
    const sshArgs = (identity, command) => [
      ...flags,
      "-T",
      "-i",
      identity,
      "-p",
      port,
      target,
      command,
    ];
    await assert.rejects(
      execute("ssh", sshArgs(other, "true"), { timeout: 20_000 }),
      (error) =>
        error.code === 255 &&
        /Permission denied \(publickey\)/u.test(error.stderr),
    );

    const input = path.join(directory, "input");
    const output = path.join(directory, "output");
    const batch = path.join(directory, "sftp.batch");
    const remote = `cantrip-ssh-fixture-${randomUUID()}`;
    const payload = Buffer.from("Cantrip SFTP fixture café 日本語\n");
    await writeFile(input, payload);
    await writeFile(
      batch,
      `put "${input}" ${remote}\nget ${remote} "${output}"\nrm ${remote}\n`,
    );
    await execute(
      "sftp",
      [...flags, "-i", key, "-P", port, "-b", batch, target],
      { timeout: 20_000 },
    );
    assert.deepEqual(await readFile(output), payload);

    idle = spawn(
      "ssh",
      sshArgs(
        key,
        'printf "%s\\n" "$(id -u)" "$PWD" "$$"; echo READY; exec cat',
      ),
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    exited = once(idle, "exit");
    let receipt = "",
      diagnostics = "";
    idle.stdout.on("data", (bytes) => {
      receipt += String(bytes);
    });
    idle.stderr.on("data", (bytes) => {
      diagnostics += String(bytes);
    });
    const guestPid = await eventually(() => {
      assert.equal(idle.exitCode, null, diagnostics);
      const [uid, home, pid, ready] = receipt.split("\n");
      assert.equal(ready, "READY", diagnostics);
      assert.equal(uid, String(actual.uid));
      assert.equal(home, actual.home);
      assert.match(pid, /^[1-9][0-9]*$/u);
      return pid;
    });
    await docker("exec", container, "test", "-d", `/proc/${guestPid}`);
    await forward.revoke();
    await forward.connection.nextControl("close");
    await eventually(() =>
      docker("exec", container, "test", "!", "-d", `/proc/${guestPid}`),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    listener?.close();
    forward?.connection.socket.terminate();
    if (idle?.exitCode === null) idle.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyCantripOsVnc(options) {
  const { call, os, docker, container, actual, eventually } = options;
  const { probeX11 } =
    await import("../../tests/reference-node-worker/test/fixtures/os-x11-probe.ts");
  const { RfbClient } =
    await import("../../tests/reference-node-worker/test/fixtures/rfb-client.ts");
  const workspaces = `/api/cantrip-os/${os.id}/workspaces`;
  const workspace = (await call("GET", workspaces)).find(
    (item) => item.guestWorkspaceId === actual.id,
  );
  const base = `${workspaces}/${workspace.id}`;
  const { target } = await call("GET", base + "/desktop");
  const started = await call("POST", base + "/desktop-operations", {
    action: "start",
    operationId: randomUUID(),
    runtimeGeneration: os.runtimeGeneration,
    attachmentGeneration: os.attachmentGeneration,
    targetGeneration: target.generation,
  });
  assert.equal(started.state, "ready", JSON.stringify(started));
  const descriptor = JSON.parse(
    await docker(
      "exec",
      "--user",
      "0",
      container,
      "/usr/bin/cantrip-remote",
      "service-info",
      actual.id,
      "--service",
      '{"kind":"vnc"}',
    ),
  );
  const probe = () =>
    probeX11({ kind: "docker", container }, descriptor.display);
  const destination = { kind: "worker-os-vnc" };
  const forward = await attachTunnel(options, "vnc", destination);
  const stream = forward.connection.stream(
    forward.route,
    undefined,
    256 * 1024,
  );
  const client = new Duplex({
    read() {},
    write(bytes, _encoding, done) {
      stream.send(
        { kind: "data", direction: "source-to-destination" },
        bytes,
        forward.configuration,
      );
      done();
    },
  });
  const closed = new Promise((resolve) =>
    client.once("close", () => resolve(null)),
  );
  let pumping;
  try {
    assert.equal(
      (await stream.next("accepted", "rejected")).header.kind,
      "accepted",
    );
    const rfb = new RfbClient(client);
    pumping = (async () => {
      try {
        while (!client.destroyed) {
          const frame = await Promise.race([
            stream.next("data", "half-close", "close", "error"),
            closed,
          ]);
          if (!frame || frame.header.kind !== "data") break;
          client.push(
            openTunnelDataFrame(
              forward.configuration,
              frame.header,
              frame.payload,
            ),
          );
        }
        client.push(null);
      } catch (error) {
        client.destroy(error);
      }
    })();
    const display = await rfb.initialize();
    assert.ok(display.width >= 800 && display.height >= 600);
    assert.ok((await rfb.rawFrame(64, 64, display.bitsPerPixel)) >= 64 * 64);
    const contender = forward.connection.stream(forward.route);
    assert.equal(
      (await contender.next("accepted", "rejected")).header.kind,
      "rejected",
    );
    rfb.key(65505, true);
    rfb.pointer(100, 100, 1);
    await eventually(async () => {
      const held = await probe();
      assert.equal(held.shift, true);
      assert.equal(held.mask & 256, 256);
    });
    await forward.revoke();
    await forward.connection.nextControl("close");
    await eventually(async () => {
      const released = await probe();
      assert.equal(released.shift, false);
      assert.equal(released.mask & 256, 0);
    });
  } finally {
    client.destroy();
    forward.connection.socket.terminate();
    await pumping;
  }
  const next = await attachTunnel(options, "vnc", destination);
  try {
    await eventually(async () => {
      const stream = next.connection.stream(next.route);
      assert.equal(
        (await stream.next("accepted", "rejected")).header.kind,
        "accepted",
      );
    });
    await next.revoke();
  } finally {
    next.connection.socket.terminate();
  }
}

export async function verifyCantripOsReverse(options) {
  const { docker, container, actual, eventually } = options;
  const guest = (...args) =>
    docker(
      "exec",
      "--user",
      String(actual.uid),
      container,
      "python3",
      "-c",
      ...args,
    );
  const port = Number(
    await guest(
      "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()",
    ),
  );
  assert.ok(Number.isInteger(port) && port > 0);
  const sockets = new Set();
  let accepted = 0;
  let halfClosedInput;
  let hostClosesFirst = false;
  const host = createServer({ allowHalfOpen: true }, (socket) => {
    accepted++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const chunks = [];
    let size = 0;
    const halfClose = hostClosesFirst;
    if (halfClose) socket.end("Host sent EOF first\n");
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) socket.destroy();
      else chunks.push(chunk);
    });
    socket.once("end", () => {
      const input = Buffer.concat(chunks);
      const digest = createHash("sha256").update(input).digest();
      if (halfClose) halfClosedInput = digest.toString("hex");
      else
        socket.end(
          Buffer.concat([
            Buffer.from("Worker host fixture\n"),
            Buffer.from(input).reverse(),
            digest,
          ]),
        );
    });
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const destination = {
    kind: "worker-tcp",
    host: "127.0.0.1",
    port: host.address().port,
  };
  let active, proof, idle;
  const heartbeat = {
    kind: "data",
    direction: "client-to-worker",
    payloadFormat: "raw",
  };
  try {
    active = await attachTunnel(options, "reverse", destination, port);
    const marker = actual.home + "/cantrip-reverse-fixture-" + randomUUID();
    proof = guest(
      `
import hashlib, pathlib, socket, sys, threading
port, ready = int(sys.argv[1]), pathlib.Path(sys.argv[2]); outcomes = []
def client(index):
    payload = bytes(range(256))*4096 + bytes([index])
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=15) as c:
            ready.with_suffix('.'+str(index)).touch()
            c.sendall(payload); c.shutdown(socket.SHUT_WR)
            response = b''.join(iter(lambda: c.recv(65536), b''))
            assert response == b'Worker host fixture\\n' + payload[::-1] + hashlib.sha256(payload).digest()
        outcomes.append(True)
    except BaseException as e:
        outcomes.append(repr(e))
threads = [threading.Thread(target=client, args=(i,)) for i in range(2)]
for t in threads: t.start()
for t in threads: t.join(17)
assert outcomes == [True, True], outcomes
print('two clients')
`,
      String(port),
      marker,
    );
    void proof.catch(() => {});
    await eventually(() =>
      guest(
        "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.with_suffix('.0').exists() and p.with_suffix('.1').exists()",
        marker,
      ),
    );
    assert.equal(
      accepted,
      0,
      "Prepared listener has not connected to the Host",
    );
    await active.activate();
    active.connection.wire(heartbeat, Uint8Array.of(0));
    assert.equal((await active.connection.nextControl("credit")).bytes, 1);
    assert.equal(await proof, "two clients");
    assert.equal(accepted, 2);
    await eventually(() => assert.equal(sockets.size, 0));

    hostClosesFirst = true;
    const digest = await guest(
      `
import hashlib, socket, sys
with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=15) as c:
    assert b''.join(iter(lambda: c.recv(65536), b'')) == b'Host sent EOF first\\n'
    payload = bytes(range(256))*4096 + b'guest tail'
    c.sendall(payload); c.shutdown(socket.SHUT_WR)
    print(hashlib.sha256(payload).hexdigest())
`,
      String(port),
    );
    await eventually(() => assert.equal(halfClosedInput, digest));
    await eventually(() => assert.equal(sockets.size, 0));
    hostClosesFirst = false;

    const idleClient = () =>
      guest(
        `
import socket, sys
with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=15) as c:
    assert c.recv(1) == b''
print('closed')
`,
        String(port),
      );
    const retired = async () => {
      assert.equal(await idle, "closed");
      await eventually(() => assert.equal(sockets.size, 0));
      await eventually(() =>
        guest(
          "import socket,sys; s=socket.socket(); s.settimeout(3); assert s.connect_ex(('127.0.0.1',int(sys.argv[1]))) != 0",
          String(port),
        ),
      );
      active.connection.socket.terminate();
    };
    idle = idleClient();
    void idle.catch(() => {});
    await eventually(() => assert.equal(sockets.size, 1));
    active.connection.wire(heartbeat, Uint8Array.of(1));
    assert.equal(
      (await active.connection.nextControl("close")).code,
      "protocol-error",
    );
    await retired();
    await active.revoke();

    active = await attachTunnel(options, "reverse", destination, port);
    await active.activate();
    idle = idleClient();
    void idle.catch(() => {});
    await eventually(() => assert.equal(sockets.size, 1));
    await active.revoke();
    await active.connection.nextControl("close");
    await retired();
  } finally {
    active?.connection.socket.terminate();
    for (const socket of sockets) socket.destroy();
    host.close();
  }
}

async function relaySsh(socket, { connection, route, configuration }) {
  const stream = connection.stream(route, undefined, 256 * 1024);
  const closed = new Promise((resolve) =>
    socket.once("close", () => resolve(null)),
  );
  try {
    assert.equal(
      (await stream.next("accepted", "rejected")).header.kind,
      "accepted",
    );
    const send = async () => {
      for await (const chunk of socket) {
        for (let offset = 0; offset < chunk.length; offset += 16 * 1024) {
          stream.send(
            { kind: "data", direction: "source-to-destination" },
            chunk.subarray(offset, offset + 16 * 1024),
            configuration,
          );
        }
      }
      if (!socket.destroyed)
        stream.send({ kind: "half-close", direction: "source-to-destination" });
    };
    const receive = async () => {
      for (;;) {
        const frame = await Promise.race([
          stream.next("data", "half-close", "close", "error"),
          closed,
        ]);
        if (!frame) return;
        if (frame.header.kind !== "data") {
          socket.end();
          return;
        }
        const plaintext = openTunnelDataFrame(
          configuration,
          frame.header,
          frame.payload,
        );
        if (!socket.write(plaintext)) await once(socket, "drain");
      }
    };
    await Promise.all([send(), receive()]);
  } finally {
    socket.destroy();
  }
}

async function attachTunnel(
  { origin, call, os, binding, workerId, componentKey },
  service,
  destination,
  listenPort,
) {
  const clientInstanceId = randomUUID();
  const session = await call(
    "POST",
    "/api/workers/" + workerId + "/worker-link/sessions",
    { clientInstanceId },
    201,
  );
  const base = "/api/worker-links/" + session.sessionId;
  const relay = await call("POST", base + "/route", {
    preferredRoute: "relay",
  });
  const tunnelId = randomUUID();
  const source = {
    bindingId: binding.id,
    worktreeId: binding.worktreeId,
    bindingGeneration: binding.bindingGeneration,
    attachmentGeneration: os.attachmentGeneration,
    runtimeGeneration: os.runtimeGeneration,
  };
  const configuration = {
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    key: randomBytes(32).toString("base64url"),
  };
  const listen = listenPort !== undefined;
  const protectedRecord = {
    operationId: tunnelId,
    revision: 1,
    protectedContent: await encryptEndpointContentPayload({
      ownerId,
      componentKey,
      keyRevision: 1,
      context: {
        domain: "tunnel-content",
        serverId: relay.identity.serverId,
        workerId,
        scopeId: JSON.stringify(["tunnel", tunnelId]),
        operationId: tunnelId,
        operation: "tunnel.record",
        direction: "stored",
        sequence: 1,
      },
      plaintext: Buffer.from(
        JSON.stringify({
          name: `Guest ${service} fixture`,
          description: null,
          source: listen
            ? { kind: "worker-os-listener", workerId, port: listenPort, source }
            : { kind: "desktop-loopback" },
          destination: listen
            ? { ...destination, workerId }
            : { ...destination, workerId, source },
          dataProtection: configuration,
        }),
      ),
    }),
  };
  const tunnel = await call(
    "POST",
    "/api/tunnels",
    {
      id: tunnelId,
      projectId: binding.projectId,
      protocolHint: "tcp",
      source: listen
        ? { kind: "worker-listener", workerId }
        : { kind: "desktop-loopback" },
      destination: listen
        ? { kind: "worker-tcp", workerId }
        : {
            kind: "worker-adapter",
            adapter: "cantrip-os",
            resourceId: tunnelId,
            workerId,
          },
      osSource: source,
      protectedRecord,
    },
    201,
  );
  assert.deepEqual(tunnel.protectedRecord, protectedRecord);
  const { attachmentId } = await call(
    "POST",
    "/api/tunnels/" + tunnelId + "/attachments",
    {
      clientId: clientInstanceId,
      ...(listen ? { kind: "worker-listener", expectedRevision: 1 } : {}),
    },
    201,
  );
  const { grant, route, ssh } = await call(
    "POST",
    base + "/tunnel-attachments/" + attachmentId + "/grant",
    {},
    201,
  );
  assert.ok(
    grant.binding.operations.includes(
      listen ? "stream:guest-listen" : "stream:guest-connect",
    ),
  );
  const url = new URL(base + "/connect", origin);
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", clientInstanceId);
  url.searchParams.set("routeGeneration", String(relay.routeGeneration));
  const connection = new Connection(url, relay);
  const activate = async () => {
    try {
      await connection.open(grant, 1024 * 1024);
    } catch (error) {
      connection.socket.terminate();
      throw error;
    }
  };
  if (!listen) await activate();
  const revoke = () =>
    call("DELETE", "/api/tunnel-attachments/" + attachmentId, undefined, 204);
  return {
    connection,
    configuration,
    route,
    protectedRecord,
    ssh,
    revoke,
    activate,
  };
}
