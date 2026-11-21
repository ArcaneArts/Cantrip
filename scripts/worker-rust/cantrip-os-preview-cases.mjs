// Exercise the native preview over a disposable, network-isolated guest.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  decryptEndpointContentPayload,
  decryptRemoteSurfaceStreamPayload,
  decryptSurfacePrivateState,
  encryptEndpointContentPayload,
  encryptRepositoryOperationPayload,
  encryptRemoteSurfaceStreamPayload,
  encryptSurfacePrivateState,
  openComputerUseResult,
  protectComputerUseRequest,
} from "../../packages/crypto/dist/index.js";
import {
  cantripOsDesktopPlacement,
  encodeRemoteSurfaceFrame,
} from "../../packages/protocol/dist/index.js";
import { createPreparedProject } from "./console-interaction-cases.mjs";
import { RemoteSurfaceWorkerLink } from "./remote-surface-worker-link-client.mjs";

const run = promisify(execFile);
async function docker(...args) {
  return (await run("docker", args, { timeout: 45000 })).stdout.trim();
}

export async function guestDockerEnvironment(root) {
  const directory = path.join(root, "guest-carrier-bin");
  await mkdir(directory);
  const executable = (await run("which", ["docker"])).stdout.trim();
  await symlink(executable, path.join(directory, "docker"));
  return {
    PATH: directory,
    DOCKER_HOST:
      (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
      (await docker(
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      )),
  };
}

async function eventually(action) {
  const deadline = Date.now() + 25000;
  for (;;) {
    try {
      return await action();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

export async function startManagedGuestDesktop(image) {
  const container = await docker(
    "run",
    "-d",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "--shm-size=256m",
    "--name",
    "cantrip-managed-cua-" + randomUUID(),
    image,
  );
  const guest = (...args) => docker("exec", "--user", "0", container, ...args);
  const guestWorkspaceId = "managed-cua";
  return {
    connections: async () =>
      JSON.parse(await guest("cantrip-remote", "status")).connections,
    desktopTarget: async () =>
      JSON.parse(
        await guest("cantrip-workspaces", "desktop-target", guestWorkspaceId),
      ),
    disableRemote: () => guest("cantrip-remote", "disable"),
    clearClipboard: (display) =>
      guest(
        "/usr/bin/python3",
        "-c",
        `import ctypes as c, sys
x11 = c.CDLL('libX11.so.6')
x11.XOpenDisplay.argtypes = [c.c_char_p]
x11.XOpenDisplay.restype = c.c_void_p
x11.XInternAtom.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
x11.XInternAtom.restype = c.c_ulong
x11.XSetSelectionOwner.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_ulong]
x11.XGetSelectionOwner.argtypes = [c.c_void_p, c.c_ulong]
x11.XGetSelectionOwner.restype = c.c_ulong
x11.XCloseDisplay.argtypes = [c.c_void_p]
display = x11.XOpenDisplay((':' + sys.argv[1]).encode())
assert display
try:
    clipboard = x11.XInternAtom(display, b'CLIPBOARD', 0)
    x11.XSetSelectionOwner(display, clipboard, 0, 0)
    assert x11.XGetSelectionOwner(display, clipboard) == 0
finally:
    x11.XCloseDisplay(display)`,
        String(display),
      ),
    seedClipboard: (display, text) =>
      guest(
        "/usr/bin/python3",
        "-c",
        "import os,subprocess,sys; subprocess.run(['/usr/bin/xclip','-selection','clipboard'],input=sys.argv[2].encode(),env={**os.environ,'DISPLAY':':'+sys.argv[1]},check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)",
        String(display),
        text,
      ),
    async placeProject({
      call,
      projectId,
      workerId,
      ownerId,
      keyRevision,
      repositoryKey,
    }) {
      await eventually(async () => {
        const status = JSON.parse(await guest("cantrip-executor", "status"));
        assert.equal(status.service, "running");
        assert.equal(status.attachment, null);
      });
      await guest("cantrip-remote", "enable");
      const transport = { kind: "docker", container };
      const observed = await call("POST", "/api/cantrip-os/inspect", 200, {
        workerId,
        transport,
      });
      const { instance } = await call("POST", "/api/cantrip-os/attach", 200, {
        workerId,
        transport,
        name: "Disposable managed computer use",
        guestInstanceId: observed.guestInstanceId,
        expectedAttachmentGeneration: null,
      });
      const workspaces = `/api/cantrip-os/${instance.id}/workspaces`;
      const created = await call("POST", workspaces, 200, {
        operationId: randomUUID(),
        guestWorkspaceId,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: instance.runtimeGeneration,
      });
      assert.equal(created.state, "ready", JSON.stringify(created));
      const workspace = (await call("GET", workspaces, 200)).find(
        (entry) => entry.guestWorkspaceId === guestWorkspaceId,
      );
      assert.ok(workspace);
      const bindings = `/api/projects/${projectId}/cantrip-os/bindings`;
      const binding = await call("POST", bindings, 200, {
        mode: "linux-owned",
        workspaceId: workspace.id,
        sourceKind: "folder",
      });
      const { server } = await call("GET", "/api/bootstrap", 200);
      const operationId = randomUUID();
      const used = {
        serverId: server.id,
        projectId,
        worktreeId: binding.worktreeId,
        operationId,
        direction: "request",
      };
      const protectedRequest = await encryptRepositoryOperationPayload({
        ownerId,
        keyRevision,
        componentKey: repositoryKey,
        context: used,
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            type: "cantrip-os.source.provision",
            instanceId: instance.id,
            workspaceId: workspace.id,
            bindingId: binding.id,
            bindingGeneration: binding.bindingGeneration,
            intent: { mode: "linux-owned", source: { kind: "folder" } },
          }),
        ),
      });
      const ready = await call(
        "POST",
        `${bindings}/${binding.id}/provision`,
        200,
        {
          operationId,
          bindingGeneration: binding.bindingGeneration,
          protectedRequest,
        },
      );
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      return {
        bindingId: binding.id,
        bindingGeneration: binding.bindingGeneration,
        worktreeId: binding.worktreeId,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: instance.runtimeGeneration,
        instanceId: instance.id,
        transport,
        workspaceId: workspace.id,
        guestWorkspaceId,
      };
    },
    close: () => docker("rm", "-f", container),
  };
}

export async function verifyManagedGuestDesktopPreparation({
  desktop,
  call,
  eventually,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  repositoryKey,
  surfaceKey,
  origin,
}) {
  const { projectId, projectUrl, label } = await createPreparedProject({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    projectName: "Guest desktop fixture",
  });
  const placement = await desktop.placeProject({
    call,
    projectId,
    ownerId,
    workerId,
    keyRevision,
    repositoryKey,
  });
  const { server } = await call("GET", "/api/bootstrap", 200);
  const create = async (id, runtimeGeneration, status) =>
    call("POST", `${projectUrl}/remote-desktops`, status, {
      id,
      titleProtection: await label(
        "project-view",
        id,
        "Assigned Linux desktop",
      ),
      stateProtection: await encryptSurfacePrivateState({
        ownerId,
        context: {
          serverId: server.id,
          resource: "remote-desktop-row",
          recordKind: "remote-desktop-state",
          resourceId: id,
          operationId: null,
        },
        keyRevision,
        componentKey: surfaceKey,
        content: {
          version: 1,
          classification: { recordKind: "remote-desktop-state" },
          revision: 1,
          target: { kind: "monitor", id: null, name: null },
        },
      }),
      cantripOsBindingId: placement.bindingId,
      cantripOsRuntimeGeneration: runtimeGeneration,
    });
  const before = await desktop.desktopTarget();
  await create(randomUUID(), randomUUID(), 409);
  assert.deepEqual(await desktop.desktopTarget(), before);

  const id = randomUUID();
  const created = await create(id, placement.runtimeGeneration, 201);
  const observed = await desktop.desktopTarget();
  assert.equal(observed.status, "running");
  assert.match(observed.desktop_generation, /^[a-f0-9]{64}$/);
  assert.deepEqual(created.osSource, {
    bindingId: placement.bindingId,
    bindingGeneration: placement.bindingGeneration,
    worktreeId: placement.worktreeId,
    attachmentGeneration: placement.attachmentGeneration,
    runtimeGeneration: placement.runtimeGeneration,
    desktopGeneration: observed.desktop_generation,
  });
  assert.deepEqual(
    await call("GET", `/api/remote-desktops/${id}`, 200),
    created,
  );
  assert.equal(
    (await desktop.connections())[placement.guestWorkspaceId],
    undefined,
  );

  if (origin) {
    const { probeX11 } =
      await import("../../tests/reference-node-worker/test/fixtures/os-x11-probe.ts");
    const viewport = { width: 640, height: 480, devicePixelRatio: 1 };
    const connect = async (surfaceId) => {
      let frame;
      let sequence = 0;
      const received = [];
      const latest = new Map();
      const link = await RemoteSurfaceWorkerLink.connect({
        origin,
        call,
        workerId,
        surfaceId,
        viewport,
        route: "relay",
        resourceKind: "remote-desktop",
        onFrame(value) {
          if (value.header.channel === "frame") frame = value;
          else {
            received.push(value);
            if (received.length > 32) received.shift();
          }
        },
      });
      const context = (header, direction) => ({
        serverId: server.id,
        surfaceKind: "desktop",
        surfaceId,
        attachmentId: link.attachment,
        channel: header.channel,
        direction,
        sequence: header.sequence,
      });
      const decrypt = ({ header, payload }) =>
        decryptRemoteSurfaceStreamPayload({
          ownerId,
          componentKey: surfaceKey,
          keyRevision,
          context: context(header, "worker-to-client"),
          protectedPayload: payload,
        });
      return {
        close: () => link.close(),
        async send(message) {
          const header = {
            protocolVersion: 1,
            surfaceId,
            attachmentId: link.attachment,
            channel: "control",
            sequence: sequence++,
          };
          const payload = await encryptRemoteSurfaceStreamPayload({
            ownerId,
            componentKey: surfaceKey,
            keyRevision,
            context: context(header, "client-to-worker"),
            plaintext: Buffer.from(JSON.stringify(message)),
          });
          await link.send(encodeRemoteSurfaceFrame(header, payload));
        },
        async message(type, verify) {
          return eventually(async () => {
            for (const frame of received.splice(0)) {
              const message = JSON.parse(
                Buffer.from(await decrypt(frame)).toString(),
              );
              latest.set(message.type, message);
            }
            return latest.get(type);
          }, verify);
        },
        async read() {
          frame = undefined;
          const { header, payload } = await eventually(
            () => frame,
            (value) => assert.ok(value, "The attached display streams frames"),
          );
          assert.equal(header.surfaceId, surfaceId);
          assert.equal(header.attachmentId, link.attachment);
          const jpeg = await decrypt({ header, payload });
          assert.deepEqual([...jpeg.subarray(0, 3)], [255, 216, 255]);
        },
      };
    };
    const viewers = [];
    try {
      const one = await connect(id);
      viewers.push(one);
      const secondSurface = await create(
        randomUUID(),
        placement.runtimeGeneration,
        201,
      );
      const two = await connect(secondSurface.id);
      viewers.push(two);
      await Promise.all([one.read(), two.read()]);
      for (const [viewer, surfaceId] of [
        [one, id],
        [two, secondSurface.id],
      ]) {
        const inventory = await viewer.message("desktop-targets", (message) => {
          assert.deepEqual(
            [message?.monitorCount, message?.windowCount],
            [1, 0],
          );
        });
        const opened = await decryptSurfacePrivateState({
          ownerId,
          componentKey: surfaceKey,
          keyRevision,
          context: {
            serverId: server.id,
            resource: "remote-desktop-inventory",
            resourceId: surfaceId,
            operationId: inventory.operationId,
            recordKind: "remote-desktop-inventory",
          },
          opaque: inventory.stateProtection,
        });
        assert.deepEqual(opened.requested, {
          kind: "monitor",
          id: null,
          name: null,
        });
        assert.equal(opened.active.id, opened.monitors[0].id);
        assert.deepEqual(opened.windows, []);
      }
      assert.equal(
        (await desktop.connections())[placement.guestWorkspaceId]?.running,
        true,
      );
      await one.send({ type: "viewport", viewport });
      await two.send({ type: "viewport", viewport });
      await verifyGuestViewerControl({
        one,
        two,
        desktop,
        observed,
        transport: placement.transport,
        eventually,
        probeX11,
      });
      await two.close();
      viewers.pop();
      await one.message("desktop-control", (status) =>
        assert.equal(status?.mode, "agent"),
      );
      await eventually(
        () => probeX11(placement.transport, observed.display),
        (state) => assert.equal(state.mask & 256, 0),
      );
      await one.read();
    } finally {
      await Promise.all(viewers.map((viewer) => viewer.close()));
    }
    await eventually(
      () => desktop.connections(),
      (connections) =>
        assert.equal(connections[placement.guestWorkspaceId], undefined),
    );
    const workspace = `/api/cantrip-os/${placement.instanceId}/workspaces/${placement.workspaceId}`;
    const { target } = await call("GET", workspace + "/desktop", 200);
    const stopped = await call("POST", workspace + "/desktop-operations", 200, {
      operationId: randomUUID(),
      action: "stop",
      runtimeGeneration: placement.runtimeGeneration,
      attachmentGeneration: placement.attachmentGeneration,
      targetGeneration: target.generation,
    });
    assert.equal(stopped.state, "ready");
    await assert.rejects(
      () => connect(id),
      /captured Linux desktop is unavailable/,
    );
    assert.equal((await desktop.desktopTarget()).status, "stopped");
    const replacement = await create(
      randomUUID(),
      placement.runtimeGeneration,
      201,
    );
    assert.notEqual(
      replacement.osSource.desktopGeneration,
      observed.desktop_generation,
    );
    const current = await connect(replacement.id);
    try {
      await current.read();
    } finally {
      await current.close();
    }
  }

  await desktop.disableRemote();
  const unavailableId = randomUUID();
  const failure = await create(unavailableId, placement.runtimeGeneration, 502);
  assert.match(
    failure.error,
    /assigned Cantrip OS desktop could not be opened/,
  );
  await call("GET", `/api/remote-desktops/${unavailableId}`, 404);
  console.log(
    JSON.stringify({
      suite: origin
        ? "native-guest-desktop-view"
        : "native-guest-desktop-preparation",
      passed: true,
    }),
  );
}

async function verifyGuestViewerControl({
  one,
  two,
  desktop,
  observed,
  transport,
  eventually,
  probeX11,
}) {
  const control = (operation, leaseId) => ({
    type: "desktop-control",
    operation,
    ...(leaseId ? { leaseId } : {}),
  });
  const pressed = (inputEpoch, inputSequence, x, y) => ({
    type: "pointer",
    event: "down",
    button: "left",
    x,
    y,
    inputEpoch,
    inputSequence,
  });
  const pointer = (held) =>
    eventually(
      () => probeX11(transport, observed.display),
      (state) => assert.equal(Boolean(state.mask & 256), held),
    );
  const active = (client) =>
    client.message("desktop-control", (state) => {
      assert.equal(state?.mode, "human");
      assert.equal(state.isController, true);
      assert.ok(state.leaseId);
    });
  const input = (client, previous) =>
    client.message("desktop-input", (state) => {
      assert.ok(state?.epoch, JSON.stringify(state));
      assert.notEqual(state.epoch, previous);
    });

  await one.send(control("take"));
  const lease = await active(one);
  const { epoch } = await input(one);
  await two.send(control("take"));
  await two.message("desktop-input", (state) =>
    assert.match(state?.message ?? "", /Another viewer/),
  );
  await two.message("desktop-control", (state) => {
    assert.equal(state?.mode, "human");
    assert.equal(state.isController, false);
  });
  const copy = (inputSequence) =>
    one.send({
      type: "clipboard",
      operation: "copy",
      inputEpoch: epoch,
      inputSequence,
    });
  await desktop.clearClipboard(observed.display);
  await copy(1);
  await one.send({
    type: "pointer",
    event: "move",
    x: 120,
    y: 85,
    inputEpoch: epoch,
    inputSequence: 2,
  });
  await eventually(
    () => probeX11(transport, observed.display),
    (state) =>
      assert.equal(
        state.x,
        120,
        "Empty copy leaves the same input epoch active",
      ),
  );
  const clipboard = "Cantrip guest clipboard 日本語";
  await desktop.seedClipboard(observed.display, clipboard);
  await copy(3);
  await one.message("desktop-clipboard", (state) =>
    assert.equal(state?.text, clipboard),
  );
  await one.send({
    type: "key",
    event: "down",
    code: "ShiftLeft",
    key: "Shift",
    inputEpoch: epoch,
    inputSequence: 4,
  });
  await one.send(pressed(epoch, 5, 321, 234));
  const held = await pointer(true);
  assert.equal(held.shift, true);
  assert.equal(held.x, 321);
  assert.equal(held.y, 234);

  await one.send({ type: "input-cancel", inputEpoch: epoch });
  const renewed = await input(one, epoch);
  assert.equal((await pointer(false)).shift, false);
  assert.equal((await active(one)).leaseId, lease.leaseId);
  await one.send(pressed(epoch, 6, 900, 500));
  await one.send(control("return", randomUUID()));
  await one.message("desktop-input", (state) =>
    assert.match(state?.message ?? "", /lease changed/),
  );
  assert.equal((await pointer(false)).x, 321);
  await one.send(pressed(renewed.epoch, 1, 445, 320));
  assert.equal((await pointer(true)).x, 445);
  await one.send(control("return", lease.leaseId));
  await one.message("desktop-control", (state) =>
    assert.equal(state?.mode, "agent"),
  );
  await pointer(false);

  await two.send(control("take"));
  await active(two);
  const next = await input(two);
  await two.send(pressed(next.epoch, 1, 250, 300));
  assert.equal((await pointer(true)).x, 250);
}

export async function verifyCantripOsPreview({
  image,
  data,
  send,
  serverId,
  workerId,
  ownerId,
  endpointKey,
  hostProcesses,
  reconnectWorker,
  openDesktopViewer,
}) {
  const name = "cantrip-preview-fixture-" + randomUUID();
  const workspaceName = "preview-check";
  let container;
  const guest = (...args) => docker("exec", "--user", "0", container, ...args);
  const request = async (command, events) => {
    const response = await send(command, events);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  const host = await hostProcesses();
  try {
    container = await docker(
      "run",
      "-d",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--shm-size=256m",
      "--name",
      name,
      image,
    );
    assert.match(container, /^[a-f0-9]{64}$/);
    const original = await eventually(async () => {
      const status = JSON.parse(await guest("cantrip-executor", "status"));
      assert.equal(status.service, "running");
      assert.equal(status.attachment, null);
      return status;
    });
    await guest("cantrip-executor", "attach", ownerId, workerId);
    const workspace = JSON.parse(
      await guest("cantrip-workspaces", "create", workspaceName),
    );
    assert.equal(workspace.id, workspaceName);
    await guest("cantrip-remote", "enable");
    const connections = async () =>
      JSON.parse(await guest("cantrip-remote", "status")).connections;
    assert.deepEqual(await connections(), {});

    const execution = {
      kind: "cantrip-os",
      transport: { kind: "docker", container },
      scope: {
        ownerId,
        workerId,
        instanceId: randomUUID(),
        guestInstanceId: original.instance_id,
        attachmentGeneration: randomUUID(),
        runtimeGeneration: original.generation,
        bindingId: randomUUID(),
        bindingGeneration: randomUUID(),
        projectId: randomUUID(),
        projectSourceId: randomUUID(),
        sourceKind: "folder",
        worktreeId: randomUUID(),
        workspaceId: randomUUID(),
        guestWorkspaceId: workspace.id,
        uid: workspace.uid,
        gid: workspace.gid,
        homeGuestPath: workspace.home,
        guestPath: workspace.home + "/checkout",
        dependencyOverlays: [],
        mode: "linux-owned",
        linkedWorkerPath: null,
      },
    };
    const baseAuthority = {
      ownerId,
      serverId,
      workerId,
      contextKind: "project",
      placementId: execution.scope.worktreeId,
      projectId: execution.scope.projectId,
      generation: 1,
      cantripAppAllowed: false,
      osPlacement: cantripOsDesktopPlacement(execution),
      profile: {
        selectedId: ":yolo",
        effectiveId: ":yolo",
        forcedByWorktreePolicy: false,
        usesDefault: false,
      },
    };
    const directory = path.join(data, "os-agent-placements");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const authority = async () => {
      const chatId = randomUUID();
      const key = createHash("sha256")
        .update(JSON.stringify([serverId, ownerId, workerId, chatId]))
        .digest("hex");
      await writeFile(
        path.join(directory, key + ".json"),
        JSON.stringify(execution),
        { mode: 0o600 },
      );
      return { ...baseAuthority, chatId };
    };
    const openLease = (authority) =>
      request({
        type: "computer-use.preview.open",
        authority,
        contentDomain: "chat",
      });
    const stopLease = ({ chatId, leaseId }) =>
      request({
        type: "computer-use.preview.stop",
        ownerId,
        serverId,
        chatId,
        leaseId,
        operationId: randomUUID(),
      });
    const crypto = { ownerId, keyRevision: 1, componentKey: endpointKey };
    async function operation(authority, lease, action) {
      const context = {
        serverId,
        workerId,
        chatId: authority.chatId,
        previewLeaseId: lease.leaseId,
        operationId: randomUUID(),
        operation: action.operation,
      };
      const protectedRequest = await protectComputerUseRequest({
        context,
        request: action,
        seal: (context, plaintext) =>
          encryptEndpointContentPayload({ ...crypto, context, plaintext }),
      });
      const events = [];
      const response = await request(
        {
          type: "computer-use.operation",
          serverId,
          chatId: authority.chatId,
          executionLaneId: null,
          preview: { leaseId: lease.leaseId, authority },
          request: protectedRequest,
        },
        events,
      );
      assert.equal(
        events.filter((item) => item.type === "computer-use.activity").length,
        1,
      );
      return openComputerUseResult({
        context,
        opaque: response,
        chunks: events.filter(
          (item) => item.type === "computer-use.snapshot.chunk",
        ),
        open: (context, opaque) =>
          decryptEndpointContentPayload({ ...crypto, context, opaque }),
      });
    }

    const first = await authority();
    const wrongRuntime = {
      ...first,
      osPlacement: { ...first.osPlacement, runtimeGeneration: randomUUID() },
    };
    const wrongLease = await openLease(wrongRuntime);
    const capabilities = { operation: "capabilities.get" };
    assert.equal(
      (await operation(wrongRuntime, wrongLease, capabilities)).result.code,
      "ownership-mismatch",
    );
    await stopLease(wrongLease);
    const { osPlacement, ...wrongHost } = first;
    const badHost = await openLease(wrongHost);
    assert.equal(
      (await operation(wrongHost, badHost, capabilities)).result.code,
      "ownership-mismatch",
    );
    await stopLease(badHost);
    assert.deepEqual(await connections(), {});
    assert.deepEqual(await hostProcesses(), host);

    const second = await authority();
    const lease = await openLease(first);
    const other = await openLease(second);
    const info = await operation(first, lease, capabilities);
    assert.equal(
      info.result.data?.backend,
      "linux-x11",
      JSON.stringify(info.result),
    );
    assert.equal((await connections())[workspaceName]?.running, true);
    const inventory = await operation(first, lease, {
      operation: "targets.list",
    });
    const monitor = inventory.result.data?.targets.find(
      ({ kind }) => kind === "monitor",
    );
    assert.ok(monitor, JSON.stringify(inventory.result));
    const target = {
      targetId: monitor.id,
      targetGeneration: monitor.generation,
    };
    const open = { operation: "session.open", ...target };
    const opened = await operation(first, lease, open);
    const sessionId = opened.result.data?.session.binding.sessionId;
    assert.ok(sessionId, JSON.stringify(opened.result));
    const otherOpened = await operation(second, other, open);
    const otherId = otherOpened.result.data?.session.binding.sessionId;
    assert.ok(
      otherId && otherId !== sessionId,
      JSON.stringify(otherOpened.result),
    );
    const prepare = {
      type: "surface.desktop.os-prepare",
      serverId,
      projectId: execution.scope.projectId,
      osExecution: execution,
    };
    const foreign = await send({ ...prepare, serverId: randomUUID() });
    assert.equal(foreign.ok, false);
    assert.match(foreign.error.message, /belongs to another owner/);
    const observed = JSON.parse(
      await guest("cantrip-workspaces", "desktop-target", workspaceName),
    );
    assert.deepEqual(await request(prepare), {
      desktopGeneration: observed.desktop_generation,
    });
    assert.equal((await connections())[workspaceName]?.running, true);
    const snapshot = await operation(first, lease, {
      operation: "observation.snapshot",
      sessionId,
      ...target,
    });
    assert.ok(snapshot.payload?.length, JSON.stringify(snapshot.result));
    assert.deepEqual(
      [...snapshot.payload.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    snapshot.payload.fill(0);
    const positioned = { ...target, sessionId, position: { x: 140, y: 110 } };
    const click = await operation(first, lease, {
      ...positioned,
      operation: "input.click",
    });
    assert.equal(
      click.result.data?.input.method,
      "coordinate",
      JSON.stringify(click.result),
    );
    assert.equal(click.result.data.input.outcome, "dispatched");
    assert.deepEqual(click.result.data.input.position, positioned.position);
    const text = "Disposable Cantrip OS clipboard ✓";
    const written = await operation(first, lease, {
      ...target,
      sessionId,
      operation: "clipboard.write",
      text,
    });
    assert.equal(written.result.status, "ok", JSON.stringify(written.result));
    const read = await operation(first, lease, {
      ...target,
      sessionId,
      operation: "clipboard.read",
    });
    assert.equal(read.result.data?.text, text, JSON.stringify(read.result));
    const resized = await operation(first, lease, {
      ...target,
      sessionId,
      operation: "desktop.resize",
      width: 800,
      height: 600,
    });
    assert.equal(
      resized.result.data?.session.target.pixelWidth,
      800,
      JSON.stringify(resized.result),
    );
    assert.equal(resized.result.data.session.target.pixelHeight, 600);
    assert.equal(
      resized.result.data.session.target.generation,
      target.targetGeneration,
    );

    await stopLease(lease);
    assert.equal((await connections())[workspaceName]?.running, true);
    const otherState = await operation(second, other, {
      operation: "session.state",
      sessionId: otherId,
    });
    assert.equal(otherState.result.data?.session.binding.sessionId, otherId);
    const { probeX11 } =
      await import("../../tests/reference-node-worker/test/fixtures/os-x11-probe.ts");
    const display = JSON.parse(
      await guest("cantrip-workspaces", "desktop-target", workspaceName),
    ).display;
    const viewer = await openDesktopViewer(
      execution,
      observed.desktop_generation,
    );
    try {
      const hold = operation(second, other, {
        operation: "input.perform",
        sessionId: otherId,
        ...target,
        command: {
          kind: "timeline",
          frames: [
            { atMs: 0, pointerDown: { x: 270, y: 210 } },
            { atMs: 60_000, pointerUp: true },
          ],
        },
      });
      // The fixture observes the real guest button, then interrupts that action
      // through the viewer on the Worker command socket.
      void hold.catch(() => {});
      assert.equal(
        (await probeX11(execution.transport, display, true)).mask & 256,
        256,
      );
      await viewer.take();
      assert.equal(
        (await probeX11(execution.transport, display, false)).mask & 256,
        0,
      );
      assert.equal((await hold).result.code, "input-unknown");
      const blocked = await operation(second, other, {
        operation: "targets.list",
      });
      assert.equal(blocked.result.code, "ownership-mismatch");
      await viewer.release();
      assert.equal(
        (
          await operation(second, other, {
            operation: "session.state",
            sessionId: otherId,
          })
        ).result.code,
        "session-not-found",
      );
      assert.equal((await operation(second, other, open)).result.status, "ok");
    } finally {
      await viewer.close();
    }
    await stopLease(other);
    await eventually(async () => assert.deepEqual(await connections(), {}));
    assert.deepEqual(await hostProcesses(), host);

    const reopened = await openLease(first);
    assert.notEqual(reopened.leaseId, lease.leaseId);
    assert.equal(
      (await operation(first, reopened, capabilities)).result.status,
      "ok",
    );
    assert.equal((await connections())[workspaceName]?.running, true);
    await reconnectWorker();
    await eventually(async () => assert.deepEqual(await connections(), {}));
    const fresh = await openLease(first);
    assert.notEqual(fresh.leaseId, reopened.leaseId);
    await stopLease(fresh);
    assert.deepEqual(await connections(), {});
    console.log(
      JSON.stringify({ suite: "native-cantrip-os-preview", passed: true }),
    );
  } finally {
    if (container) await docker("rm", "-f", container);
  }
}
