import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { TerminalRelayProbe } from "../server-rust/terminal-relay-probe.mjs";

export async function verifyHostTerminal({
  call,
  eventually,
  origin,
  ownerId,
  serverId,
  surfaceKey,
  metadataKey,
  projectId,
  checkout,
}) {
  const id = randomUUID();
  const context = {
    serverId,
    resource: "terminal-row",
    resourceId: id,
    operationId: null,
    recordKind: "terminal-state",
  };
  const stateProtection = await crypto.encryptSurfacePrivateState({
    ownerId,
    context,
    keyRevision: 1,
    componentKey: surfaceKey,
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: { kind: "project-root" },
      serviceCommand: "",
    },
  });
  const titleProtection = await crypto.encryptPrivateDisplayLabel({
    ownerId,
    recordKind: "terminal",
    rowId: id,
    keyRevision: 1,
    componentKey: metadataKey,
    label: "Native shell relay",
  });
  const added = await call("POST", `/api/projects/${projectId}/terminals`, {
    id,
    titleProtection,
    stateProtection,
  });
  assert.equal(added.status, 201, JSON.stringify(added));
  const fixture = {
    server: { origin },
    client: () => ({ cookies: new Map() }),
  };
  const views = [];
  const marker = `shell-proof-${randomUUID()}`;
  const terminalPath = `/api/terminals/${id}`;
  async function attach() {
    const operationId = randomUUID();
    const relay = new TerminalRelayProbe(
      fixture,
      terminalPath + "/connect?operationId=" + operationId,
    );
    views.push(relay);
    await relay.open();
    const binding = (direction, sequence) => ({
      serverId,
      surfaceKind: "terminal",
      surfaceId: id,
      operationId,
      direction,
      sequence,
    });
    const secret = { ownerId, keyRevision: 1, componentKey: surfaceKey };
    let sequence = 0,
      outputSequence = 0,
      data = "";
    async function output(frame) {
      assert.equal(frame.type, "output", JSON.stringify(frame));
      assert.equal(frame.operationId, operationId);
      assert.equal(frame.sequence, outputSequence);
      const bytes = await crypto.decryptSurfaceStreamPayload({
        ...secret,
        context: binding("output", outputSequence++),
        opaque: frame.protectedData,
      });
      const content = JSON.parse(Buffer.from(bytes).toString());
      assert.equal(content.type, "terminal.output");
      data += content.data;
    }
    for (;;) {
      const frame = await relay.next();
      if (frame.type === "ready") break;
      await output(frame);
    }
    return {
      relay,
      replay: data,
      async input(text) {
        const protectedData = await crypto.encryptSurfaceStreamPayload({
          ...secret,
          context: binding("input", sequence),
          plaintext: Buffer.from(
            JSON.stringify({ type: "terminal.input", data: text }),
          ),
        });
        relay.send({
          type: "input",
          operationId,
          sequence: sequence++,
          protectedData,
        });
      },
      async read(match) {
        while (!match.test(data)) await output(await relay.next());
      },
    };
  }
  let deleted = false;
  try {
    const first = await attach();
    // A marker assembled by the shell cannot match the PTY's command echo.
    const token = marker.slice("shell-proof-".length);
    await first.input(
      `printf '%s%s\\n' shell-proof- '${token}'; printf '%s' "$$" > native-shell-pid\r`,
    );
    await first.read(new RegExp(marker));
    const pidFile = path.join(checkout, "native-shell-pid");
    const pid = await eventually(
      () => readFile(pidFile, "utf8").catch(() => ""),
      (value) => assert.match(value, /^[0-9]+$/),
      "shell runs in the private worktree",
    );
    assert.ok(!first.relay.history.some(({ raw }) => raw.includes(marker)));

    first.relay.send({ type: "resize", cols: 113, rows: 43 });
    // Resizing and input travel in separate server tasks. Confirm the actual
    // terminal dimensions from within the PTY.
    const sizeFile = path.join(checkout, "native-shell-size");
    await eventually(
      async () => {
        await first.input("/bin/stty size > native-shell-size\r");
        return readFile(sizeFile, "utf8").catch(() => "");
      },
      (value) => assert.equal(value.trim(), "43 113"),
      "actual PTY size",
    );

    await first.relay.close();
    const second = await attach();
    assert.ok(second.replay.includes(marker), "replay arrives before ready");
    await second.input('printf "%s" "$$" > native-shell-reattached\r');
    await eventually(
      () =>
        readFile(path.join(checkout, "native-shell-reattached"), "utf8").catch(
          () => "",
        ),
      (value) => assert.equal(value, pid),
      "reattachment keeps the same shell",
    );
    await second.input("exit 7\r");
    const exited = await second.relay.next((frame) =>
      ["exit", "error"].includes(frame.type),
    );
    assert.deepEqual(exited, { type: "exit", exitCode: 7, signal: null });
    await second.relay.close();

    const third = await attach();
    await third.input('printf "%s" "$$" > native-shell-reopened\r');
    await eventually(
      () =>
        readFile(path.join(checkout, "native-shell-reopened"), "utf8").catch(
          () => "",
        ),
      (value) => {
        assert.match(value, /^[0-9]+$/);
        assert.notEqual(value, pid);
      },
      "a new shell opens after an exit",
    );
    const removed = await call("DELETE", terminalPath);
    assert.equal(removed.status, 204, JSON.stringify(removed));
    deleted = true;
    const closed = await third.relay.next((frame) =>
      ["exit", "error"].includes(frame.type),
    );
    assert.equal(closed.type, "exit", JSON.stringify(closed));
  } finally {
    for (const view of views) await view.close();
    if (!deleted) await call("DELETE", terminalPath);
  }
}
