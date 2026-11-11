import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { actualWorkerTunnelLink } from "./actual-worker-tunnel-link.mjs";
import { eventually } from "./full-worker.mjs";

async function authorizeSurfaceWorker(page, workerId) {
  await page.evaluate(async (workerId) => {
    const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
    const { ensureSurfacePrivateStateWorkerEncryption } =
      await import("/src/lib/surface-private-state-worker-encryption.ts");
    await ensureSurfacePrivateStateWorkerEncryption({
      worker: (await getWorkers()).find((entry) => entry.workerId === workerId),
    });
  }, workerId);
}

async function hostDesktop(page, projectId, workerId, fakeInventory) {
  const fleetPath = `/api/projects/${projectId}/remote-desktop-fleet`;
  const [packet, observed] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === fleetPath,
    ),
    page.evaluate(
      async ({ projectId, workerId }) => {
        const api = await import("/src/lib/api/surfaces.ts");
        const { request } = await import("/src/lib/api-client.ts");
        const fleet = await api.getRemoteDesktopFleet(projectId);
        const inventory = fleet.workers.find(
          (entry) => entry.workerId === workerId,
        );
        if (!inventory)
          throw new Error(
            "The fixture worker was absent from desktop discovery",
          );
        let probe;
        try {
          const desktop = await api.createRemoteDesktop(projectId, undefined, {
            kind: "worker",
            projectId,
            workerId,
          });
          await request(`/api/project-views/${desktop.id}`, {
            method: "DELETE",
          });
          probe = { status: 201 };
        } catch (error) {
          if (error.status !== 409) throw error;
          probe = { status: error.status, message: error.message };
        }
        return {
          probe,
          inventory: {
            status: inventory.status,
            monitorCount: inventory.inventory.monitors.length,
            windowCount: inventory.inventory.windows.length,
            error: inventory.error,
          },
        };
      },
      { projectId, workerId },
    ),
  ]);
  assert.equal(packet.status(), 200);
  const wire = (await packet.json()).workers.find(
    (entry) => entry.workerId === workerId,
  );
  assert.equal(wire.status, observed.inventory.status);
  if (wire.status === "ok") {
    assert.ok(wire.inventoryProtection.protectedState.envelope.ciphertext);
    assert.equal(Object.hasOwn(wire, "inventory"), false);
    assert.equal(observed.inventory.monitorCount, wire.monitorCount);
    assert.equal(observed.inventory.windowCount, wire.windowCount);
  }
  if (fakeInventory) {
    assert.deepEqual(observed.inventory, {
      status: "ok",
      monitorCount: 1,
      windowCount: 1,
      error: null,
    });
    for (const label of ["CUA fixture monitor", "CUA fixture window"])
      assert.ok(!JSON.stringify(wire).includes(label));
  }
  return observed;
}

async function openGuestDesktop(page, desktop) {
  await page.evaluate(async ({ id, workerId }) => {
    const { RemoteSurfaceWorkerLinkClient } =
      await import("/src/lib/remote-surface-worker-link.ts");
    const viewport = { width: 1440, height: 900, devicePixelRatio: 1 };
    const observed = (window.actualGuestDesktopState = {
      routes: null,
      error: null,
      state: null,
      control: null,
      jpegBytes: 0,
    });
    const client = new RemoteSurfaceWorkerLinkClient({
      messages: {
        connectionError: "Guest desktop connection failed",
        invalidFrame: "Guest desktop returned an invalid encrypted frame",
      },
      streamKind: "desktop",
      surfaceKind: "remote-desktop",
      surfaceId: id,
      workerId,
      viewport: () => viewport,
      onConnectionState() {},
      onReady(routes) {
        observed.routes = routes;
        if (
          !client.send(
            "control",
            new TextEncoder().encode(
              JSON.stringify({
                type: "viewport",
                viewport,
              }),
            ),
          )
        )
          throw new Error("Guest desktop viewport was not admitted");
      },
      onError(error) {
        observed.error = error;
      },
      onFrame({ header, payload }) {
        if (header.channel === "frame") {
          if (
            payload[0] !== 255 ||
            payload[1] !== 216 ||
            payload.at(-2) !== 255 ||
            payload.at(-1) !== 217
          )
            throw new Error(
              "Authenticated guest frame was not a complete JPEG",
            );
          observed.jpegBytes = payload.byteLength;
          return;
        }
        if (header.channel !== "control") return;
        const message = JSON.parse(new TextDecoder().decode(payload));
        if (message.type === "desktop-state") observed.state = message;
        if (message.type === "desktop-control") observed.control = message;
      },
    });
    window.actualGuestDesktop = client;
    client.start();
  }, desktop);
  try {
    return await eventually(
      () => page.evaluate(() => window.actualGuestDesktopState),
      (value) => {
        assert.equal(value.error, null);
        assert.deepEqual(value.routes, {
          interactive: "relay",
          realtime: "relay",
        });
        assert.equal(value.state?.status, "ready");
        assert.ok(value.state.width >= 800);
        assert.ok(value.state.height >= 600);
        assert.equal(value.control?.mode, "agent");
        assert.equal(value.control.isController, false);
        assert.ok(value.jpegBytes > 1000);
      },
      40000,
    );
  } finally {
    await page
      .evaluate(() => window.actualGuestDesktop?.close())
      .catch(() => {});
  }
}

const echoService = `import hashlib, json, pathlib, socket, sys
directory = pathlib.Path(sys.argv[1])
with socket.socket() as server:
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(90)
    (directory / "guest-echo.port").write_text(str(server.getsockname()[1]))
    peer, _ = server.accept()
    with peer:
        peer.settimeout(30)
        data = b"".join(iter(lambda: peer.recv(65536), b""))
        (directory / "guest-echo.json").write_text(json.dumps([
            {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        ]))
        peer.sendall(b"authenticated-guest-reply:" + data)
        peer.shutdown(socket.SHUT_WR)
`;

async function guestTunnel({
  page,
  guest,
  selected,
  projectId,
  workerId,
  source,
  guestPath,
  result,
}) {
  await guest.docker(
    "exec",
    "-d",
    "-u",
    `${selected.uid}:${selected.gid}`,
    guest.id,
    "python3",
    "-c",
    echoService,
    guestPath,
  );
  const port = await eventually(
    () =>
      guest
        .exec("cat", path.posix.join(guestPath, "guest-echo.port"))
        .then(Number, () => null),
    (value) =>
      assert.ok(Number.isInteger(value) && value > 0 && value <= 65535),
  );
  const token = "private-cantrip-os-tunnel-" + randomUUID();
  const prepared = await page.evaluate(
    async ({ projectId, workerId, source, port, token }) => {
      const api = await import("/src/lib/api/tunnels.ts");
      const { request } = await import("/src/lib/api-client.ts");
      const row = await api.createTunnel({
        name: token,
        description: null,
        projectId,
        protocolHint: "tcp",
        destination: { kind: "worker-os-tcp", workerId, source, port },
      });
      const wire = await request(`/api/tunnels/${row.id}`);
      const attachment = await api.createTunnelAttachment(row.id, {
        clientId: crypto.randomUUID(),
      });
      return {
        id: row.id,
        openedDestination: row.destination,
        attachmentId: attachment.attachmentId,
        wire,
        dataProtection: await api.getTunnelDataProtection(row.id),
      };
    },
    { projectId, workerId, source, port, token },
  );
  try {
    assert.deepEqual(prepared.openedDestination, {
      kind: "worker-os-tcp",
      workerId,
      source,
      port,
    });
    assert.deepEqual(prepared.wire.destination, {
      kind: "worker-adapter",
      adapter: "cantrip-os",
      workerId,
      resourceId: prepared.id,
    });
    assert.ok(!JSON.stringify(prepared.wire).includes(token));
    const plaintext = Buffer.from(token + ":" + "x".repeat(40000));
    await actualWorkerTunnelLink({
      page,
      result,
      tunnel: {
        id: prepared.id,
        attachmentId: prepared.attachmentId,
        workerId,
        dataProtection: prepared.dataProtection,
        protectedRecord: prepared.wire.protectedRecord,
        plaintext,
        reply: Buffer.concat([
          Buffer.from("authenticated-guest-reply:"),
          plaintext,
        ]),
        readReceived: async () =>
          JSON.parse(
            await guest.exec(
              "cat",
              path.posix.join(guestPath, "guest-echo.json"),
            ),
          ),
      },
    });
  } finally {
    await page.evaluate(async ({ id, attachmentId }) => {
      const api = await import("/src/lib/api/tunnels.ts");
      await api.deleteTunnelAttachment(attachmentId);
      await api.deleteTunnel(id);
    }, prepared);
  }
}

export async function actualCantripOsSurfaces({
  page,
  call,
  os,
  desktop,
  guest,
  fixture,
  instance,
  selected,
  projectId,
  fakeHostDesktopInventory,
  workerId,
  stopWorker,
  startWorker,
  result,
  report,
}) {
  const evidence = (report.surfaces = {});
  await authorizeSurfaceWorker(page, workerId);
  evidence.host = await hostDesktop(
    page,
    projectId,
    workerId,
    fakeHostDesktopInventory,
  );
  const binding = await os("createCantripOsBinding", projectId, {
    mode: "linux-owned",
    workspaceId: selected.id,
    sourceKind: "folder",
  });
  const provision = await os("prepareCantripOsProvisionRequest", binding, {
    mode: "linux-owned",
    source: { kind: "folder" },
  });
  assert.equal(
    (await os("submitCantripOsProvision", binding, provision)).state,
    "ready",
  );
  const verified = await os("verifyCantripOsBinding", projectId, binding.id);
  assert.equal(verified.state, "ready");
  assert.equal(
    verified.provisionedRuntimeGeneration,
    instance.runtimeGeneration,
  );
  const source = {
    bindingId: verified.id,
    worktreeId: verified.worktreeId,
    bindingGeneration: verified.bindingGeneration,
    attachmentGeneration: verified.provisionedAttachmentGeneration,
    runtimeGeneration: verified.provisionedRuntimeGeneration,
  };
  const status = await desktop("getCantripOsDesktop", instance, selected);
  assert.ok(status.target, JSON.stringify(status));
  const intent = await call(
    "cantrip-os-desktop-draft",
    "prepareCantripOsDesktopDraft",
    status.target,
    "start",
  );
  intent.submitted = true;
  await call("cantrip-os-desktop-draft", "saveCantripOsDesktopDraft", intent);
  const started = await desktop("submitCantripOsDesktop", intent);
  assert.equal(started.state, "ready");
  assert.equal((await guest.target()).status, "running");

  const create = (runtimeGeneration) =>
    call(
      "api/surfaces",
      "createRemoteDesktop",
      projectId,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        bindingId: verified.id,
        runtimeGeneration,
      },
    );
  evidence.stale = await page.evaluate(
    async ({ projectId, bindingId }) => {
      const { createRemoteDesktop } = await import("/src/lib/api/surfaces.ts");
      try {
        await createRemoteDesktop(
          projectId,
          undefined,
          undefined,
          undefined,
          undefined,
          { bindingId, runtimeGeneration: crypto.randomUUID() },
        );
        throw new Error("The retired Linux placement was accepted");
      } catch (error) {
        if (error.status !== 409) throw error;
        return { status: error.status, message: error.message };
      }
    },
    { projectId, bindingId: verified.id },
  );
  const view = await create(instance.runtimeGeneration);
  evidence.desktopId = view.id;
  assert.equal(view.osSource.bindingId, verified.id);
  assert.equal(view.osSource.runtimeGeneration, instance.runtimeGeneration);
  assert.match(view.osSource.desktopGeneration, /^[a-f0-9]{64}$/u);
  const getWire = () =>
    call("api-client", "request", `/api/remote-desktops/${view.id}`);
  const wire = await getWire();
  assert.ok(wire.titleProtection && wire.stateProtection);
  assert.equal(Object.hasOwn(wire, "title"), false);
  assert.equal(Object.hasOwn(wire, "target"), false);
  evidence.desktop = await openGuestDesktop(page, view);
  await page.evaluate(() => window.folderLive.stop());
  await stopWorker();
  evidence.restart = await fixture.restart();
  await startWorker();
  await authorizeSurfaceWorker(page, workerId);
  await page.evaluate(() => window.folderLive.start());
  const retained = await getWire();
  for (const key of [
    "titleProtection",
    "stateProtection",
    "osSource",
    "stateRevision",
  ])
    assert.deepEqual(retained[key], wire[key]);
  evidence.reopenedDesktop = await openGuestDesktop(page, view);
  await call("api-client", "request", `/api/project-views/${view.id}`, {
    method: "DELETE",
  });
  await guestTunnel({
    page,
    guest,
    selected,
    projectId,
    workerId,
    source,
    guestPath: verified.guestPath,
    result,
  });
  evidence.summary = {
    host: {
      probe: evidence.host.probe,
      inventoryStatus: evidence.host.inventory.status,
    },
    stale: evidence.stale,
    desktop: {
      liveCapture: true,
      retainedCapture: true,
      encryptedStateRetained: true,
    },
    tunnel: {
      guestEcho: true,
      encryptedFrames: true,
      halfClose: true,
      grantReleased: true,
    },
  };
  result.steps.push(
    "real Linux guest desktop and TCP service use encrypted browser routes through the full worker, including desktop reopen after server and worker restart",
  );
}
