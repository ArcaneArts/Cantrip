// Real encrypted service configuration and PTYs in workspace-smoke's owned
// checkout/profile. No GUI, external deployment or user process is involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
import { attachTerminal } from "./terminal-relay-client.mjs";
import { attachWorkerLinkTerminal } from "./worker-link-terminal-client.mjs";
export async function verifyTerminalServices({
  call,
  eventually,
  ownerId,
  serverId,
  surfaceKey,
  metadataKey,
  projectId,
  checkout,
  origin,
  workerId,
}) {
  const id = crypto.randomUUID();
  const marker = path.join(checkout, "native-terminal-starts"),
    hungUp = path.join(checkout, "native-terminal-hup");
  const setup =
    "printf 'started\\n' >> native-terminal-starts; trap 'printf h >> native-terminal-hup; exit 0' HUP;";
  const command = origin
    ? setup +
      ' printf \'%s\' "$$" > native-service-pid; printf \'private-service-%s\\n\' "$$"; while IFS= read -r line; do case "$line" in probe) /bin/stty size > native-service-size; printf \'private-service-input-%s\\n\' "$$";; finish) exec /bin/sh -c \'kill -TERM "$$"\';; esac; done'
    : setup + " while :; do /bin/sleep 0.05; done";
  const stateProtection = await c.encryptSurfacePrivateState({
    ownerId,
    context: {
      serverId,
      resource: "terminal-row",
      resourceId: id,
      operationId: null,
      recordKind: "terminal-state",
    },
    keyRevision: 1,
    componentKey: surfaceKey,
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: { kind: "project-root" },
      serviceCommand: command,
    },
  });
  const titleProtection = await c.encryptPrivateDisplayLabel({
    ownerId,
    recordKind: "terminal",
    rowId: id,
    keyRevision: 1,
    componentKey: metadataKey,
    label: "Native service",
  });
  const created = await call("POST", `/api/projects/${projectId}/terminals`, {
    id,
    titleProtection,
    stateProtection,
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  const count = async () =>
    ((await readFile(marker, "utf8").catch(() => "")).match(/started/g) ?? [])
      .length;
  const waitCount = async (number) =>
    eventually(
      count,
      (value) => assert.equal(value, number),
      `native terminal service start ${number}`,
    );
  const enabled = await call("PUT", `/api/terminals/${id}/service`, {
    enabled: true,
    stateProtection,
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled));
  assert.equal(enabled.body.status, "running");
  await waitCount(1);
  const bad = structuredClone(stateProtection),
    bytes = c.decodeBase64Url(bad.protectedState.envelope.ciphertext);
  bytes[0] ^= 1;
  bad.protectedState.envelope.ciphertext = c.encodeBase64Url(bytes);
  const rejected = await call("PUT", `/api/terminals/${id}/service`, {
    enabled: true,
    stateProtection: bad,
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected));
  assert.equal(rejected.body.status, "offline");
  const restored = await call("PUT", `/api/terminals/${id}/service`, {
    enabled: true,
    stateProtection,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(restored.body.status, "running");
  assert.equal(await count(), 1);
  let startsBeforeWorkerRestart = 2;
  const pidFile = path.join(checkout, "native-service-pid");
  const sizeFile = path.join(checkout, "native-service-size");
  const processId = async (previous) =>
    eventually(
      () => readFile(pidFile, "utf8").catch(() => ""),
      (pid) => {
        assert.match(pid, /^\d+$/);
        assert.notEqual(pid, previous);
      },
      "native service process attempt",
    );
  const views = [];
  const attach = async () => {
    const view = await attachTerminal({
      origin,
      ownerId,
      serverId,
      surfaceKey,
      id,
    });
    views.push(view);
    return view;
  };
  try {
    const first = origin ? await attach() : null;
    const firstPid = first ? await processId() : null;
    if (first) {
      await first.read(new RegExp(`private-service-${firstPid}`));
      first.relay.send({ type: "resize", cols: 110, rows: 41 });
      await eventually(
        async () => {
          await first.input("probe\r");
          return readFile(sizeFile, "utf8").catch(() => "");
        },
        (value) => assert.equal(value.trim(), "41 110"),
        "size of attached service PTY",
      );
      await first.read(new RegExp(`private-service-input-${firstPid}`));
      assert.ok(
        !first.relay.history.some(({ raw }) =>
          raw.includes("private-service-"),
        ),
      );
    }
    const restarted = await call(
      "POST",
      `/api/terminals/${id}/service/restart`,
      {},
    );
    assert.equal(restarted.status, 202, JSON.stringify(restarted));
    await waitCount(2);
    await eventually(
      () => readFile(hungUp, "utf8"),
      (value) => assert.equal(value, "h"),
      "owned terminal SIGHUP cleanup",
    );
    if (first) {
      const secondPid = await processId(firstPid);
      await first.read(new RegExp(`private-service-${secondPid}`));
      const second = await attach();
      assert.ok(second.replay.includes(`private-service-${secondPid}`));
      assert.ok(!second.replay.includes(`private-service-${firstPid}`));
      const link = await attachWorkerLinkTerminal({
        origin,
        call,
        workerId,
        ownerId,
        serverId,
        surfaceKey,
        id,
      });
      try {
        assert.ok(link.replay.includes("private-service-" + secondPid));
        await link.input("probe\r");
        await link.read(new RegExp("private-service-input-" + secondPid));
      } finally {
        await link.close();
      }
      await first.relay.close();
      await second.input("finish\r");
      await second.read(/Service exited 0; restarting in 5 seconds/);
      const waiting = await attach();
      assert.ok(waiting.replay.includes("Service exited 0"));
      waiting.relay.send({ type: "resize", cols: 107, rows: 37 });
      await waitCount(3);
      startsBeforeWorkerRestart = 3;
      const thirdPid = await processId(secondPid);
      await waiting.read(new RegExp(`private-service-${thirdPid}`));
      await waiting.input("probe\r");
      await waiting.read(new RegExp(`private-service-input-${thirdPid}`));
      assert.equal((await readFile(sizeFile, "utf8")).trim(), "37 107");
    }
  } finally {
    for (const view of views) await view.relay.close();
  }
  return async () => {
    const expected = startsBeforeWorkerRestart + 1;
    await waitCount(expected);
    const view = origin ? await attach() : null;
    if (view)
      await view.read(new RegExp(`private-service-${await processId()}`));
    const disabled = await call("PUT", `/api/terminals/${id}/service`, {
      enabled: false,
      stateProtection,
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled));
    assert.equal(disabled.body.status, "idle");
    await eventually(
      () => readFile(hungUp, "utf8"),
      (value) => assert.equal(value, "hhh"),
      "service disabled after worker restart",
    );
    if (view) {
      try {
        const exited = await view.relay.next((frame) =>
          ["exit", "error"].includes(frame.type),
        );
        assert.equal(exited.type, "exit", JSON.stringify(exited));
      } finally {
        await view.relay.close();
      }
    }
    assert.equal(await count(), expected);
  };
}
