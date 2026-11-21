import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import path from "node:path";
import { TerminalHydrationController } from "../../cantrip_app/src/components/terminal/terminal-hydration.ts";
import * as crypto from "../../packages/crypto/dist/index.js";
import { verifyLegacyDirectTerminal } from "./terminal-direct-smoke.mjs";
import { attachTerminal } from "./terminal-relay-client.mjs";
import { attachWorkerLinkTerminal } from "./worker-link-terminal-client.mjs";

async function verifyNormalReflow(view, reattach, eventually, checkout) {
  const { Terminal } = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  )("@xterm/headless");
  const token = randomUUID();
  const anchor = "log-" + token.slice(0, 8);
  const line = anchor + "abc".repeat(47) + "界" + "e\u0301".repeat(12);
  const filler = Array.from({ length: 40 }, (_, i) => "scroll-" + i).join(" ");
  const cleared = "\x1b[H\x1b[2J";
  const ready = "reflow-ready-" + token;
  await view.input(
    `/bin/stty -echo; printf '\\033[H\\033[2J\\033[3J'; i=0; while [ "$i" -lt 120 ]; do printf '%088d\\n' "$i"; i=$((i + 1)); done; printf '\\033[31m%s\\033[m\\n' '${line}'; printf '%s\\n' ${filler}; printf '%s%s\\n' reflow-ready- '${token}'; for step in narrow wide; do IFS= read -r line; /bin/stty size > "native-reflow-$step"; done; IFS= read -r line; /bin/stty echo\r`,
  );
  const raw = await view.read(new RegExp(ready + "\\r?\\n"));
  const start = raw.lastIndexOf(cleared);
  assert.notEqual(start, -1);
  const reference = new Terminal({
    cols: 113,
    rows: 43,
    allowProposedApi: true,
  });
  const write = (term, output) =>
    new Promise((resolve) => term.write(output, resolve));
  const scrollback = (term) => {
    const buffer = term.buffer.active;
    const all = Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row),
    );
    const first = all.findIndex((row) =>
      row.translateToString(true).startsWith(anchor),
    );
    assert.ok(first >= 0 && first < buffer.baseY, "anchor is in scrollback");
    return all
      .slice(first)
      .map((row) => [
        row.translateToString(true),
        row.isWrapped,
        row.getCell(0).getFgColor(),
      ]);
  };
  try {
    await write(reference, raw.slice(start));
    assert.ok(
      reference.buffer.active.getLine(reference.buffer.active.baseY).isWrapped,
      "the initial line crosses from scrollback into the viewport",
    );
    for (const [phase, cols] of [
      ["narrow", 24],
      ["wide", 113],
    ]) {
      view.relay.send({ type: "resize", cols, rows: 43 });
      await view.input("\r");
      await eventually(
        () =>
          readFile(path.join(checkout, "native-reflow-" + phase), "utf8").catch(
            () => "",
          ),
        (value) => assert.equal(value.trim(), "43 " + cols),
        "actual PTY dimensions during reflow",
      );
      reference.resize(cols, 43);
      const attached = await reattach();
      const replay = new Terminal({ cols, rows: 43, allowProposedApi: true });
      try {
        assert.equal(attached.hydration.format, "canonical-xterm");
        assert.ok(attached.hydration.snapshotChunks > 1);
        assert.ok(
          attached.hydration.outputBoundary > view.hydration.outputBoundary,
        );
        assert.equal(
          attached.hydration.processGeneration,
          view.hydration.processGeneration,
        );
        assert.equal(
          attached.hydration.scrollbackRows,
          reference.buffer.normal.baseY,
        );
        const controller = new TerminalHydrationController();
        controller.begin(attached.hydration, replay);
        for (const part of attached.snapshotParts) {
          await write(replay, part);
          controller.consumedOutput();
        }
        assert.deepEqual(controller.assertReady(), attached.hydration);
        assert.ok(scrollback(reference).some(([text]) => text.includes("界")));
        assert.deepEqual(scrollback(replay), scrollback(reference));
        assert.equal(
          replay.buffer.active.cursorY,
          reference.buffer.active.cursorY,
        );
        assert.equal(
          replay.buffer.active.cursorX,
          reference.buffer.active.cursorX,
        );
      } finally {
        replay.dispose();
        await attached.close();
      }
    }
    await view.input("\r");
  } finally {
    reference.dispose();
  }
}

async function verifyInputModes(view, reattach) {
  const { Terminal } = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  )("@xterm/headless");
  const token = randomUUID();
  const cleared = "\x1b[H\x1b[2J";
  await view.input(
    "/bin/stty -echo; printf '\\033[H\\033[2J\\033[3J%s%s' modes-ready- '" +
      token +
      "'; printf '\\033[2;8r\\033[?6h\\033[3;4Habcde\\033[3;5H\\033[4h\\033[?45;1004;66h\\033[?7l\\033[?2026h'; IFS= read -r line; printf '\\033[?2026lX\\033[4;6HZ\\033[8;1H%s%s' modes-live- '" +
      token +
      "'; IFS= read -r line; printf '\\033[4l\\033[?6;45;1004;66l\\033[?7h\\033[r%s%s\\n' modes-reset- '" +
      token +
      "'; /bin/stty echo\r",
  );
  const raw = await view.read(
    new RegExp("modes-ready-" + token + "[\\s\\S]*\\x1b\\[\\?2026h"),
  );
  const start = raw.lastIndexOf(cleared);
  assert.notEqual(start, -1);

  const attached = await reattach();
  const options = { cols: 113, rows: 43, allowProposedApi: true };
  const live = new Terminal(options);
  const replay = new Terminal(options);
  const write = (term, output) =>
    new Promise((resolve) => term.write(output, resolve));
  const viewport = (term) => {
    const buffer = term.buffer.active;
    return {
      cursor: [buffer.cursorX, buffer.cursorY],
      text: Array.from({ length: options.rows }, (_, row) =>
        buffer.getLine(buffer.baseY + row).translateToString(true),
      ),
    };
  };

  let pendingReads = 2;
  try {
    await write(live, raw.slice(start));
    assert.equal(live.modes.insertMode, true);
    assert.equal(live.modes.wraparoundMode, false);
    assert.equal(live.modes.reverseWraparoundMode, true);
    assert.equal(live.modes.sendFocusMode, true);
    assert.equal(live.modes.applicationKeypadMode, true);
    assert.equal(live.modes.originMode, true);
    // Retained viewers may still have modes from an earlier attachment.
    await write(replay, "\x1b[3;5r\x1b[?6h\x1b[4h\x1b[?7l\x1b[?1003;1006h");
    const controller = new TerminalHydrationController();
    controller.begin(attached.hydration, replay);
    for (const part of attached.snapshotParts) {
      await write(replay, part);
      controller.consumedOutput();
    }
    assert.deepEqual(controller.assertReady(), attached.hydration);
    assert.equal(attached.hydration.activeBuffer, "normal");
    assert.deepEqual(attached.hydration.cursor, {
      x: live.buffer.active.cursorX,
      y: live.buffer.active.cursorY,
    });
    assert.equal(live.modes.synchronizedOutputMode, true);
    assert.deepEqual(attached.hydration.modes, live.modes);
    assert.deepEqual(replay.modes, {
      ...live.modes,
      synchronizedOutputMode: false,
    });
    assert.deepEqual(viewport(replay), viewport(live));

    await attached.input("\r");
    pendingReads--;
    const output = await attached.read(new RegExp("modes-live-" + token));
    const continuation = output.slice(attached.replay.length);
    await write(live, continuation);
    await write(replay, continuation);
    assert.equal(viewport(live).text[3], "   aXbcde");
    assert.equal(viewport(live).text[7], "modes-live-" + token);
    assert.deepEqual(viewport(replay), viewport(live));
  } finally {
    for (let i = 0; i < pendingReads; i++) await view.input("\r");
    await view.read(new RegExp("modes-reset-" + token));
    live.dispose();
    replay.dispose();
    await attached.close();
  }
}

async function verifyCharacterSets(view, reattach) {
  const { Terminal } = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  )("@xterm/headless");
  const token = randomUUID();
  const clear = "\x1b[H\x1b[2J";
  await view.input(
    "/bin/stty -echo; printf '\\033[H\\033[2J\\033[3J\\033(0lqk\\033(B\\n\\033)0\\016x\\033*A\\033n#\\017\\n%s%s\\016' charset-ready- '" +
      token +
      "'; IFS= read -r line; printf '\\nmqqj\\033n#\\017%s%s\\n' charset-live- '" +
      token +
      "'; IFS= read -r line; printf '\\017\\033(B\\033)B\\033*B%s%s\\n' charset-reset- '" +
      token +
      "'; /bin/stty echo\r",
  );
  const raw = await view.read(new RegExp("charset-ready-" + token + "\\x0e"));
  const start = raw.lastIndexOf(clear);
  assert.notEqual(start, -1);

  const attached = await reattach();
  const options = { cols: 113, rows: 43, allowProposedApi: true };
  const live = new Terminal(options);
  const replay = new Terminal(options);
  const write = (term, output) =>
    new Promise((resolve) => term.write(output, resolve));
  const lines = (term) => {
    const buffer = term.buffer.active;
    return Array.from({ length: 4 }, (_, row) =>
      buffer.getLine(buffer.baseY + row).translateToString(true),
    );
  };
  let pendingReads = 2;
  try {
    assert.equal(attached.hydration.format, "canonical-xterm");
    await write(live, raw.slice(start));
    await write(replay, attached.replay);
    assert.deepEqual(lines(live).slice(0, 2), ["┌─┐", "│£"]);
    assert.deepEqual(lines(replay), lines(live));

    await attached.input("\r");
    pendingReads--;
    const output = await attached.read(new RegExp("charset-live-" + token));
    const continuation = output.slice(attached.replay.length);
    await write(live, continuation);
    await write(replay, continuation);
    assert.equal(lines(live)[3], "└──┘£charset-live-" + token);
    assert.deepEqual(lines(replay), lines(live));
  } finally {
    for (let i = 0; i < pendingReads; i++) await view.input("\r");
    await view.read(new RegExp("charset-reset-" + token));
    live.dispose();
    replay.dispose();
    await attached.close();
  }
}

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
    assert.equal(attached.hydration.activeBuffer, "alternate");
    assert.equal(term.buffer.active.type, "alternate");
    assert.deepEqual(attached.hydration.cursor, {
      x: term.buffer.active.cursorX,
      y: term.buffer.active.cursorY,
    });
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

async function verifyFallbackRedraw(view, reattach, eventually, checkout) {
  const cols = 400;
  const rows = 320;
  const suffix = randomUUID();
  const script = [
    "/bin/stty -echo",
    "trap '/bin/stty size >> native-redraw-sizes' WINCH",
    '/usr/bin/awk \'BEGIN { printf "\\033[H\\033[2J\\033[3J"; for (y = 0; y < 320; y++) { if (y) printf "\\n"; for (x = 0; x < 400; x++) printf "\\033[38;2;%d;64;32mX", x % 2 ? 123 : 224; } }\'',
    "printf '\\033[0m\\033[H%s%s' redraw-ready- '" + suffix + "'",
    'while :; do line=; IFS= read -r line || :; [ "$line" = release ] && break; done',
    "trap - WINCH",
    "/bin/stty echo",
    "printf '\\033[H\\033[2J\\033[3J%s%s\\n' redraw-done- '" + suffix + "'",
  ].join("\n");
  await writeFile(path.join(checkout, "native-redraw-fixture.sh"), script);
  view.relay.send({ type: "resize", cols, rows });
  await eventually(
    async () => {
      await view.input("/bin/stty size > native-redraw-start-size\r");
      return readFile(
        path.join(checkout, "native-redraw-start-size"),
        "utf8",
      ).catch(() => "");
    },
    (value) => assert.equal(value.trim(), rows + " " + cols),
    "actual PTY size before oversized terminal output",
  );
  const dimensions = async () =>
    (
      await readFile(path.join(checkout, "native-redraw-sizes"), "utf8").catch(
        () => "",
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  await view.input(". ./native-redraw-fixture.sh\r");
  await view.read(new RegExp("redraw-ready-" + suffix));
  const expected = [rows + " " + (cols - 1), rows + " " + cols];
  const verifyRecovery = async () => {
    const attached = await reattach();
    try {
      assert.equal(attached.hydration.format, "legacy-raw");
      assert.equal(attached.hydration.truncated, true);
      assert.equal(attached.hydration.recovery, "redraw-requested");
      assert.equal(attached.hydration.recoveryReason, undefined);
      assert.equal(attached.hydration.cols, cols);
      assert.equal(attached.hydration.rows, rows);
      assert.equal(attached.hydration.processGeneration, 1);
      assert.equal(attached.hydration.snapshotCharacters, 2_000_000);
      assert.ok(attached.hydration.snapshotChunks > 128);
    } finally {
      await attached.close();
    }
  };
  try {
    await verifyRecovery();
    await eventually(
      dimensions,
      (value) => assert.deepEqual(value, expected),
      "redraw pulses the real terminal and restores its original size",
    );
    await verifyRecovery();
    assert.deepEqual(await dimensions(), expected);
  } finally {
    await view.input("release\r");
    await view.read(new RegExp("redraw-done-" + suffix));
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
    assert.equal(linkExit.hydration.format, "canonical-xterm");
    assert.equal(linkExit.hydration.processGeneration, 1);
    assert.ok(linkExit.hydration.outputBoundary > 0);
    assert.equal(linkExit.hydration.rows, 43);
    assert.equal(linkExit.hydration.cols, 113);
    assert.equal(linkExit.hydration.snapshotCharacters, linkExit.replay.length);
    await verifyNormalReflow(linkExit, attachWorkerLink, eventually, checkout);
    await verifyInputModes(linkExit, attachWorkerLink);
    await verifyCharacterSets(linkExit, attachWorkerLink);
    await verifyAlternateReplay(
      linkExit,
      attachWorkerLink,
      eventually,
      checkout,
    );
    await verifyFallbackRedraw(
      linkExit,
      attachWorkerLink,
      eventually,
      checkout,
    );
    await linkExit.input("exit 143\r");
    assert.deepEqual(await linkExit.relay.next(({ type }) => type === "exit"), {
      type: "exit",
      exitCode: 143,
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
    assert.deepEqual(exited, { type: "exit", exitCode: 143, signal: null });
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
    const linkSignal = await attachWorkerLink();
    try {
      await linkSignal.input("exec /bin/sh -c 'kill -TERM \"$$\"'\r");
      const signalExit = {
        type: "exit",
        exitCode: 0,
        signal: constants.signals.SIGTERM,
      };
      assert.deepEqual(
        await linkSignal.relay.next(({ type }) => type === "exit"),
        signalExit,
      );
      assert.deepEqual(
        await third.relay.next(({ type }) => type === "exit"),
        signalExit,
      );
    } finally {
      await linkSignal.close();
      await third.relay.close();
    }
    const fourth = await attach();
    const removed = await call("DELETE", terminalPath);
    assert.equal(removed.status, 204, JSON.stringify(removed));
    deleted = true;
    const closed = await fourth.relay.next((frame) =>
      ["exit", "error"].includes(frame.type),
    );
    assert.equal(closed.type, "exit", JSON.stringify(closed));
  } finally {
    for (const view of views) await view.close();
    if (!deleted) await call("DELETE", terminalPath);
  }
}
