import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { verifyLegacyDirectTerminal } from "./terminal-direct-smoke.mjs";
import { attachTerminal } from "./terminal-relay-client.mjs";
import { attachWorkerLinkTerminal } from "./worker-link-terminal-client.mjs";

async function verifyAlternateReplay(view, reattach, eventually, checkout) {
  const { Terminal } = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  )("@xterm/headless");
  const token = randomUUID();
  const normal = "normal-" + token;
  const alternate = "alternate-" + token;
  const restored = "restored-" + token;
  // The prompt cannot redraw either screen until both reads complete.
  await view.input(
    `/bin/stty -echo; printf '\\033[H\\033[2J%s%s\\033[3;5H\\033[?1049h\\033[H%s%s' normal- '${token}' alternate- '${token}'; IFS= read -r line; /bin/stty size > native-alternate-size; IFS= read -r line; printf '\\033[?1049l%s%s\\n' restored- '${token}'; /bin/stty echo\r`,
  );
  await view.read(new RegExp(alternate));
  view.relay.send({ type: "resize", cols: 114, rows: 43 });
  await view.input("\r");
  await eventually(
    () =>
      readFile(path.join(checkout, "native-alternate-size"), "utf8").catch(
        () => "",
      ),
    (value) => assert.equal(value.trim(), "43 114"),
    "actual PTY resize while the alternate screen is active",
  );

  const attached = await reattach();
  const term = new Terminal({ cols: 114, rows: 43, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  try {
    assert.equal(attached.hydration.snapshotCharacters, attached.replay.length);
    await write(attached.replay);
    assert.equal(term.buffer.active.type, "alternate");
    assert.equal(
      term.buffer.active.getLine(0).translateToString(true),
      alternate,
    );
    await attached.input("\r");
    const output = await attached.read(new RegExp(restored));
    await write(output.slice(attached.replay.length));
    assert.equal(term.buffer.active.type, "normal");
    const line = (offset) =>
      term.buffer.active
        .getLine(term.buffer.active.baseY + offset)
        .translateToString(true);
    assert.equal(line(0), normal);
    assert.equal(line(2), "    " + restored);
  } finally {
    term.dispose();
    await attached.close();
  }
}

export async function verifyHostTerminal({
  call,
  eventually,
  origin,
  workerId,
  ownerId,
  serverId,
  surfaceKey,
  metadataKey,
  projectId,
  checkout,
  cli,
  directBroker,
  connectionPath,
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
  const views = [];
  const marker = `shell-proof-${randomUUID()}`;
  const terminalPath = `/api/terminals/${id}`;
  async function attach() {
    const view = await attachTerminal({
      origin,
      ownerId,
      serverId,
      surfaceKey,
      id,
    });
    views.push(view.relay);
    return view;
  }
  async function attachWorkerLink() {
    const view = await attachWorkerLinkTerminal({
      origin,
      call,
      workerId,
      ownerId,
      serverId,
      surfaceKey,
      id,
    });
    views.push(view);
    return view;
  }
  const verifyDirect = (proof = {}) =>
    verifyLegacyDirectTerminal({
      binary: directBroker,
      call,
      checkout,
      ownerId,
      serverId,
      surfaceKey,
      id,
      ...proof,
    });
  let deleted = false;
  try {
    const bootstrap = directBroker && (await verifyDirect());
    const first = await attach();
    if (bootstrap) assert.ok(first.replay.includes(bootstrap.marker));
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

    if (bootstrap) {
      assert.equal(pid, bootstrap.pid);
      await verifyDirect({ marker, pid });
    }

    const link = await attachWorkerLink();
    assert.ok(
      link.replay.includes(marker),
      "WorkerLink replays the existing shell",
    );
    link.relay.send({ type: "resize", cols: 111, rows: 42 });
    const relayToken = randomUUID();
    await link.input(
      "printf '%s%s\\n' link-proof- '" +
        relayToken +
        "'; /bin/stty size > native-link-size; printf '%s' \"$$\" > native-link-pid\r",
    );
    await link.read(new RegExp("link-proof-" + relayToken));
    assert.ok(
      !link.relay.history.some(({ raw }) =>
        raw.includes("link-proof-" + relayToken),
      ),
    );
    await eventually(
      () =>
        readFile(path.join(checkout, "native-link-size"), "utf8").catch(
          () => "",
        ),
      (value) => assert.equal(value.trim(), "42 111"),
      "WorkerLink resize reaches the PTY",
    );
    await eventually(
      () =>
        readFile(path.join(checkout, "native-link-pid"), "utf8").catch(
          () => "",
        ),
      (value) => assert.equal(value, pid),
      "WorkerLink uses the same shell",
    );
    await link.revoke();
    await link.close();

    if (cli) {
      await first.input(
        "cantrip --context lane --json status > .cantrip-cli-fixture-terminal-status\r",
      );
      await eventually(
        () =>
          readFile(
            path.join(checkout, ".cantrip-cli-fixture-terminal-status"),
            "utf8",
          ).catch(() => ""),
        (value) => {
          assert.ok(value);
          const result = JSON.parse(value);
          assert.equal(
            result.target?.projectId ?? result.data.context.projectId,
            projectId,
          );
        },
        "CLI resolves the real Host Terminal lane",
      );

      const invoke = async (args) => {
        const { stdout } = await promisify(execFile)(
          cli,
          ["--context", "lane", "--json", "terminal", ...args],
          {
            cwd: checkout,
            env: {
              ...process.env,
              CANTRIP_CLI_CONNECTION: connectionPath,
              CANTRIP_TERMINAL_ID: id,
            },
            timeout: 10_000,
          },
        );
        return JSON.parse(stdout);
      };
      const snapshot = await invoke(["read", "--target", id]);
      assert.equal(snapshot.target.surfaceId, id);
      assert.equal(snapshot.data.terminalId, id);
      assert.equal(snapshot.data.status, "running");
      assert.ok(snapshot.data.data.includes(marker));

      const inputMarker = randomUUID();
      const sent = await invoke([
        "send",
        "--target",
        id,
        "--raw",
        `printf '%s%s\\n' cli-terminal- '${inputMarker}'\r`,
      ]);
      assert.equal(sent.target.surfaceId, id);
      assert.equal(sent.summary, "Sent encrypted terminal input.");
      assert.equal(sent.mutated, true);
      await first.read(new RegExp(`cli-terminal-${inputMarker}`));
    }
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
    const linkExit = await attachWorkerLink();
    assert.ok(linkExit.replay.includes(marker));
    assert.equal(linkExit.hydration.format, "legacy-raw");
    assert.equal(linkExit.hydration.rows, 43);
    assert.equal(linkExit.hydration.cols, 113);
    assert.equal(linkExit.hydration.snapshotCharacters, linkExit.replay.length);
    await verifyAlternateReplay(
      linkExit,
      attachWorkerLink,
      eventually,
      checkout,
    );
    await linkExit.input("exit 7\r");
    assert.deepEqual(await linkExit.relay.next(({ type }) => type === "exit"), {
      type: "exit",
      exitCode: 7,
      signal: null,
    });
    assert.equal(
      (await linkExit.relay.nextWire(({ kind }) => kind === "close")).header
        .code,
      "normal",
    );
    await linkExit.close();
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
