import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { cantripOsExecutionSchema } from "../../packages/protocol/dist/index.js";
import { attachTerminal } from "./terminal-relay-client.mjs";

export async function verifyGuestTerminal({
  call,
  origin,
  guest,
  target,
  os,
  data,
  serverId,
  eventually,
  crashWorker,
  surfaceKey,
  metadataKey,
}) {
  const ownerId = os.ownerId;
  const id = randomUUID();
  const { projectId, worktreeId, guestPath } = target;
  const terminalPath = "/api/terminals/" + id;
  const created = await call(
    "POST",
    `/api/projects/${projectId}/terminals`,
    {
      id,
      worktreeId,
      cantripOsBindingId: target.id,
      cantripOsRuntimeGeneration: os.runtimeGeneration,
      titleProtection: await crypto.encryptPrivateDisplayLabel({
        ownerId,
        recordKind: "terminal",
        rowId: id,
        keyRevision: 1,
        componentKey: metadataKey,
        label: "Guest shell",
      }),
      stateProtection: await crypto.encryptSurfacePrivateState({
        ownerId,
        keyRevision: 1,
        componentKey: surfaceKey,
        context: {
          serverId,
          resource: "terminal-row",
          resourceId: id,
          operationId: null,
          recordKind: "terminal-state",
        },
        content: {
          version: 1,
          classification: { recordKind: "terminal-state" },
          directory: { kind: "project-root" },
          serviceCommand: "",
        },
      }),
    },
    201,
  );
  assert.equal(created.cantripOsBindingId, target.id);
  const views = [];
  const attach = async () => {
    const view = await attachTerminal({
      origin,
      id,
      ownerId,
      serverId,
      surfaceKey,
    });
    views.push(view.relay);
    return view;
  };
  const get = (file) => guest("cat", path.posix.join(guestPath, file));
  const records = path.join(data, "os-terminal-carriers");
  const hash = (input) =>
    createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const key = hash({ terminalId: id, owner: ownerId, server: serverId });
  const remove = () =>
    fetch(origin + terminalPath, {
      method: "DELETE",
      signal: AbortSignal.timeout(25_000),
      headers: { origin: "http://127.0.0.1:5173" },
    });
  let removed = false;
  try {
    const first = await attach();
    const nonce = randomUUID();
    const marker = "guest-pty-" + nonce;
    await first.input(
      `printf '%s%s\\n' guest-pty- '${nonce}'; pwd > fixture-cwd; tty > fixture-tty; printf '%s\\n' "$$" >> fixture-pid\r`,
    );
    await first.read(new RegExp(marker, "u"));
    await eventually(async () => {
      assert.equal(await get("fixture-cwd"), guestPath);
      assert.match(await get("fixture-tty"), /^\/dev\/pts\/\d+$/u);
      assert.match(await get("fixture-pid"), /^\d+$/u);
    });
    const pid = await get("fixture-pid");
    const index = JSON.parse(
      await readFile(path.join(records, "index", key + ".json"), "utf8"),
    );
    const descriptor = JSON.parse(
      await readFile(
        path.join(records, index.identity, "descriptor.json"),
        "utf8",
      ),
    );
    assert.equal(
      index.identity,
      hash({
        terminalId: id,
        execution: cantripOsExecutionSchema.parse(descriptor.execution),
        cwd: guestPath,
        serverId,
      }),
    );
    const nativePath = path.join(records, index.identity, "native.json");
    const admission = JSON.parse(await readFile(nativePath, "utf8"));
    assert.match(admission.processId, /^[a-f0-9-]{36}$/u);
    assert.ok(!first.relay.history.some(({ raw }) => raw.includes(marker)));

    first.relay.send({ type: "resize", cols: 112, rows: 43 });
    await eventually(async () => {
      await first.input("stty size > fixture-size\r");
      assert.equal(await get("fixture-size"), "43 112");
    });
    await first.relay.close();
    const second = await attach();
    assert.ok(second.replay.includes(marker));
    await crashWorker();
    await second.relay.close();
    const recovered = await attach();
    await recovered.read(new RegExp(marker, "u"));
    await recovered.input("printf '%s' \"$$\" > fixture-reopened\r");
    await eventually(async () =>
      assert.equal(await get("fixture-reopened"), pid),
    );
    assert.equal(await get("fixture-pid"), pid);
    assert.deepEqual(JSON.parse(await readFile(nativePath, "utf8")), admission);

    await crashWorker();
    await recovered.relay.close();
    assert.equal((await remove()).status, 204);
    removed = true;
    const stopped = JSON.parse(await readFile(nativePath, "utf8"));
    assert.equal(stopped.exited.outcome, "interrupted");
    assert.equal(stopped.processId, admission.processId);
    assert.equal(stopped.sessionId, admission.sessionId);
    const running = await guest(
      "sh",
      "-c",
      'if kill -0 "$1" 2>/dev/null; then echo running; else echo stopped; fi',
      "fixture",
      pid,
    );
    assert.equal(running, "stopped");
    console.log(
      "Native guest PTY input, resize, ciphertext, retained output, restart and cold close passed.",
    );
  } finally {
    for (const view of views) await view.close();
    if (!removed) await remove();
  }
}
