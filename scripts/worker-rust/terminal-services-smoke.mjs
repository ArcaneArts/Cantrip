// Real encrypted service configuration and PTYs in workspace-smoke's owned
// checkout/profile. No GUI, external deployment or user process is involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
export async function verifyTerminalServices({
  call,
  eventually,
  ownerId,
  serverId,
  surfaceKey,
  metadataKey,
  projectId,
  checkout,
}) {
  const id = crypto.randomUUID();
  const marker = path.join(checkout, "native-terminal-starts"),
    hungUp = path.join(checkout, "native-terminal-hup");
  const command =
    "printf 'started\\n' >> native-terminal-starts; trap 'printf h >> native-terminal-hup; exit 0' HUP; while :; do /bin/sleep 0.05; done";
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
  return async () => {
    await waitCount(3);
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
    assert.equal(await count(), 3);
  };
}
