// Legacy socket frames use the production endpoint crypto and a real worker PTY.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";
export async function actualWorkerTerminalRelay({
  page,
  projectId,
  worktreeId,
  directory,
  result,
}) {
  const token = "private-terminal-relay-" + crypto.randomUUID(),
    program = `terminal-relay-${crypto.randomUUID()}.cjs`,
    proof = `terminal-relay-${crypto.randomUUID()}.json`;
  await writeFile(
    path.join(directory, program),
    `require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({token:process.argv[2],pid:process.pid}));console.log(process.argv[2]);\n`,
  );
  let terminal;
  try {
    terminal = await page.evaluate(
      async ({ projectId, worktreeId, schemaUrl }) => {
        const api = await import("/src/lib/api/terminals.ts");
        const terminal = await api.createTerminal(
          projectId,
          "Private legacy relay",
          worktreeId,
        );
        const crypto = await import("/src/lib/surface-stream-encryption.ts"),
          protocol = await import(schemaUrl),
          connections = await import("/src/lib/server-connections.ts");
        const operationId = globalThis.crypto.randomUUID();
        const url = new URL(
          `/api/terminals/${terminal.id}/connect`,
          connections.getActiveServerUrl(),
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("operationId", operationId);
        const socket = new WebSocket(url);
        const state = (window.actualTerminalRelay = {
          ready: false,
          closed: null,
          error: null,
          output: "",
          sequence: 0,
          pending: Promise.resolve(),
          socket,
          operationId,
          terminalId: terminal.id,
          crypto,
          protocol,
        });
        socket.onclose = (event) => {
          state.closed = { code: event.code, reason: event.reason };
        };
        socket.onerror = () => {
          state.error = "Actual terminal relay transport failed";
        };
        socket.onmessage = (event) => {
          state.pending = state.pending
            .then(async () => {
              const message = protocol.terminalServerMessageSchema.parse(
                JSON.parse(event.data),
              );
              if (message.type === "ready") state.ready = true;
              else if (message.type === "error")
                throw new Error(message.message);
              else if (message.type === "output") {
                if (
                  message.operationId !== operationId ||
                  message.sequence !== state.sequence
                )
                  throw new Error(
                    "Actual legacy terminal output sequence mismatch",
                  );
                state.sequence++;
                const content = await crypto.openSurfaceStreamContent({
                  context: {
                    surfaceKind: "terminal",
                    surfaceId: terminal.id,
                    operationId,
                    direction: "output",
                    sequence: message.sequence,
                  },
                  opaque: message.protectedData,
                  schema: protocol.terminalOutputContentSchema,
                });
                state.output += content.data;
              }
            })
            .catch((error) => {
              state.error = error.message;
            });
        };
        return terminal;
      },
      {
        projectId,
        worktreeId,
        schemaUrl:
          "/@fs/" +
          path
            .join(repositoryRoot, "packages/protocol/src/index.ts")
            .replaceAll("\\", "/")
            .replace(/^\//, ""),
      },
    );
    const state = () =>
      page.evaluate(async () => {
        const s = window.actualTerminalRelay;
        await s.pending;
        return {
          ready: s.ready,
          closed: s.closed,
          error: s.error,
          output: s.output,
          sequence: s.sequence,
        };
      });
    await eventually(state, (s) => {
      assert.equal(s.error, null);
      assert.equal(s.closed, null);
      assert.equal(s.ready, true);
    });
    await page.evaluate(async (input) => {
      const s = window.actualTerminalRelay;
      const protectedData = await s.crypto.protectSurfaceStreamContent({
        context: {
          surfaceKind: "terminal",
          surfaceId: s.terminalId,
          operationId: s.operationId,
          direction: "input",
          sequence: 0,
        },
        content: { type: "terminal.input", data: input },
        schema: s.protocol.terminalInputContentSchema,
      });
      s.socket.send(
        JSON.stringify(
          s.protocol.terminalClientMessageSchema.parse({
            type: "input",
            operationId: s.operationId,
            sequence: 0,
            protectedData,
          }),
        ),
      );
    }, `node ${program} ${token}\r`);
    await eventually(
      async () => {
        try {
          return JSON.parse(
            await readFile(path.join(directory, proof), "utf8"),
          );
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      },
      (value) => {
        assert.equal(value?.token, token);
        assert.ok(value.pid > 0);
      },
    );
    await eventually(state, (s) => {
      assert.equal(s.error, null);
      assert.equal(s.closed, null);
      assert.ok(s.sequence > 0);
      assert.ok(s.output.includes(token));
    });
    await page.evaluate(() => window.actualTerminalRelay.socket.close(1000));
    await eventually(state, (s) =>
      assert.deepEqual(s.closed, { code: 1000, reason: "" }),
    );
    result.terminalLegacyRelay = {
      terminalId: terminal.id,
      encryptedInputExecuted: true,
      encryptedOutputOpened: true,
      orderedOutput: true,
      clientCloseCode: 1000,
    };
    result.steps.push(
      "legacy terminal WebSocket carries authenticated encrypted input to a real PTY and returns authenticated ordered encrypted output",
    );
  } finally {
    await page
      .evaluate(() => window.actualTerminalRelay?.socket.close(1000))
      .catch(() => {});
    if (terminal)
      await page.evaluate(
        async (id) =>
          (await import("/src/lib/api/terminals.ts")).deleteTerminal(id),
        terminal.id,
      );
  }
}
