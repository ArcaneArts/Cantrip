import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";

/** Real encrypted terminal relay to the production worker's native Codex PTY. */
export async function openSuspensionTerminal(
  page,
  chatId,
  workerId,
  terminalId,
) {
  const id = await page.evaluate(
    async ({ chatId, workerId, terminalId, schemaUrl }) => {
      const terminal = terminalId
        ? { id: terminalId }
        : await (
            await import("/src/lib/api/chats.ts")
          ).createChatConsole(chatId);
      if (!terminalId) {
        const repeated = await (
          await import("/src/lib/api/chats.ts")
        ).createChatConsole(chatId);
        if (repeated.id !== terminal.id)
          throw new Error(
            "Repeated console creation changed its durable identity",
          );
      }
      const worker = (
        await (await import("/src/lib/api/worker-wire.ts")).getWorkers()
      ).find((value) => value.workerId === workerId);
      await (
        await import("/src/lib/surface-private-state-worker-encryption.ts")
      ).ensureSurfacePrivateStateWorkerEncryption({ worker });
      const crypto = await import("/src/lib/surface-stream-encryption.ts");
      const protocol = await import(schemaUrl);
      const origin = (
        await import("/src/lib/server-connections.ts")
      ).getActiveServerUrl();
      const operationId = globalThis.crypto.randomUUID();
      const url = new URL(`/api/terminals/${terminal.id}/connect`, origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("operationId", operationId);
      const socket = new WebSocket(url);
      const state = (window.suspensionTerminal = {
        id: terminal.id,
        operationId,
        socket,
        output: "",
        ready: false,
        error: null,
        closed: null,
        incoming: Promise.resolve(),
        outgoing: Promise.resolve(),
        inputSequence: 0,
        outputSequence: 0,
      });
      state.send = (data) => {
        const sent = state.outgoing.then(async () => {
          const sequence = state.inputSequence++;
          const protectedData = await crypto.protectSurfaceStreamContent({
            context: {
              surfaceKind: "terminal",
              surfaceId: state.id,
              operationId,
              direction: "input",
              sequence,
            },
            content: { type: "terminal.input", data },
            schema: protocol.terminalInputContentSchema,
          });
          socket.send(
            JSON.stringify(
              protocol.terminalClientMessageSchema.parse({
                type: "input",
                operationId,
                sequence,
                protectedData,
              }),
            ),
          );
        });
        state.outgoing = sent.catch((error) => {
          state.error = error.message;
        });
        return sent;
      };
      socket.onclose = (event) => {
        state.closed = { code: event.code, reason: event.reason };
      };
      socket.onerror = () => {
        state.error = "Native terminal relay failed";
      };
      socket.onmessage = (event) => {
        state.incoming = state.incoming
          .then(async () => {
            const message = protocol.terminalServerMessageSchema.parse(
              JSON.parse(event.data),
            );
            if (message.type === "ready") {
              state.ready = true;
              socket.send(
                JSON.stringify({ type: "resize", cols: 130, rows: 45 }),
              );
            } else if (message.type === "error")
              throw new Error(message.message);
            else if (message.type === "exit")
              throw new Error(`Native terminal exited: ${message.exitCode}`);
            else if (message.type === "output") {
              if (
                message.operationId !== operationId ||
                message.sequence !== state.outputSequence++
              )
                throw new Error("Native terminal output sequence mismatch");
              const content = await crypto.openSurfaceStreamContent({
                context: {
                  surfaceKind: "terminal",
                  surfaceId: state.id,
                  operationId,
                  direction: "output",
                  sequence: message.sequence,
                },
                opaque: message.protectedData,
                schema: protocol.terminalOutputContentSchema,
              });
              state.output += content.data;
              // Answer actual terminal capability queries, as a physical terminal does.
              for (const [query, reply] of [
                ["\x1b[6n", "\x1b[1;1R"],
                ["\x1b[c", "\x1b[?1;2c"],
                ["\x1b]10;?", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"],
                ["\x1b]11;?", "\x1b]11;rgb:0000/0000/0000\x1b\\"],
              ])
                if (content.data.includes(query)) await state.send(reply);
            }
          })
          .catch((error) => {
            state.error = error.message;
          });
      };
      return terminal.id;
    },
    {
      chatId,
      workerId,
      terminalId,
      schemaUrl:
        "/@fs/" +
        path
          .join(repositoryRoot, "packages/protocol/src/index.ts")
          .replace(/^\//, ""),
    },
  );
  const require = createRequire(
    path.join(repositoryRoot, "cantrip_worker/package.json"),
  );
  const { Terminal } = require("@xterm/headless");
  const display = new Terminal({
    cols: 130,
    rows: 45,
    allowProposedApi: true,
    scrollback: 10000,
  });
  let offset = 0;
  const read = async () => {
    const state = await page.evaluate(async () => {
      const state = window.suspensionTerminal;
      await state.incoming;
      return {
        ready: state.ready,
        error: state.error,
        closed: state.closed,
        output: state.output,
      };
    });
    assert.equal(state.error, null, state.output.slice(-2000));
    assert.equal(state.closed, null);
    const delta = state.output.slice(offset);
    offset = state.output.length;
    if (delta) await new Promise((resolve) => display.write(delta, resolve));
    const buffer = display.buffer.active;
    return {
      ...state,
      text: Array.from(
        { length: buffer.length },
        (_, row) => buffer.getLine(row)?.translateToString(true) ?? "",
      ).join("\n"),
    };
  };
  await eventually(read, (state) => {
    assert.equal(state.ready, true);
    assert.ok(state.text.includes("OpenAI Codex"), state.text.slice(-2000));
  });
  return {
    id,
    read,
    input: (data) =>
      page.evaluate((data) => window.suspensionTerminal.send(data), data),
    dispose: () => display.dispose(),
  };
}
