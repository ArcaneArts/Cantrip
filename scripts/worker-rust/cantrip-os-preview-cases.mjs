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
  encryptEndpointContentPayload,
  encryptRepositoryOperationPayload,
  encryptSurfacePrivateState,
  openComputerUseResult,
  protectComputerUseRequest,
} from "../../packages/crypto/dist/index.js";
import { cantripOsDesktopPlacement } from "../../packages/protocol/dist/index.js";
import { createPreparedProject } from "./console-interaction-cases.mjs";

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

  await desktop.disableRemote();
  const unavailableId = randomUUID();
  const failure = await create(unavailableId, placement.runtimeGeneration, 502);
  assert.match(
    failure.error,
    /assigned Cantrip OS desktop could not be opened/,
  );
  await call("GET", `/api/remote-desktops/${unavailableId}`, 404);
  console.log(
    JSON.stringify({ suite: "native-guest-desktop-preparation", passed: true }),
  );
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
