// Unmodified browser terminal transport/crypto -> full worker -> actual PTY.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { repositoryRoot } from "./build.mjs";
export async function actualWorkerTerminalLink({
  page,
  projectId,
  worktreeId,
  workerId,
  directory,
  result,
  route = "relay",
}) {
  const token = "private-terminal-link-" + crypto.randomUUID(),
    program = `terminal-link-${crypto.randomUUID()}.cjs`,
    proof = `terminal-link-${crypto.randomUUID()}.json`;
  await writeFile(
    path.join(directory, program),
    `require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({token:process.argv[2],pid:process.pid}));console.log(process.argv[2]);\n`,
  );
  const requests = [];
  const response = (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/api/worker-links/"))
      requests.push({
        path: pathname,
        method: response.request().method(),
        status: response.status(),
      });
  };
  page.on("response", response);
  let terminal;
  try {
    terminal = await page.evaluate(
      async ({ projectId, worktreeId, workerId, schemaUrl }) => {
        const api = await import("/src/lib/api/terminals.ts");
        const terminal = await api.createTerminal(
          projectId,
          "private interactive WorkerLink",
          worktreeId,
        );
        const crypto = await import("/src/lib/surface-stream-encryption.ts"),
          schemas = await import("/src/lib/terminal-worker-link.ts");
        const protocol = await import(schemaUrl);
        window.actualTerminalLinkState = {
          ready: false,
          closed: null,
          output: "",
          sequence: 0,
          error: null,
        };
        window.actualTerminalLinkOperation = globalThis.crypto.randomUUID();
        window.actualTerminalLinkCrypto = crypto;
        window.actualTerminalLinkSchemas = protocol;
        window.actualTerminalLinkConnection =
          await schemas.openTerminalWorkerLink({
            terminalId: terminal.id,
            workerId,
            operationId: window.actualTerminalLinkOperation,
            onClose: (code) => {
              window.actualTerminalLinkState.closed = code;
            },
            onMessage: async (message) => {
              const state = window.actualTerminalLinkState;
              try {
                if (message.type === "ready") state.ready = true;
                else if (message.type === "output") {
                  if (
                    message.operationId !==
                      window.actualTerminalLinkOperation ||
                    message.sequence !== state.sequence
                  )
                    throw new Error("Actual terminal output sequence mismatch");
                  state.sequence++;
                  const content = await crypto.openSurfaceStreamContent({
                    context: {
                      surfaceKind: "terminal",
                      surfaceId: terminal.id,
                      operationId: window.actualTerminalLinkOperation,
                      direction: "output",
                      sequence: message.sequence,
                    },
                    opaque: message.protectedData,
                    schema: protocol.terminalOutputContentSchema,
                  });
                  state.output += content.data;
                } else if (message.type === "error")
                  throw new Error(message.message);
              } catch (error) {
                state.error = error.message;
                throw error;
              }
            },
          });
        window.actualTerminalLinkConnection.activate();
        return {
          ...terminal,
          route: window.actualTerminalLinkConnection.route,
        };
      },
      {
        projectId,
        worktreeId,
        workerId,
        schemaUrl:
          "/@fs/" +
          path
            .join(repositoryRoot, "packages/protocol/src/surface-stream.ts")
            .replaceAll("\\", "/")
            .replace(/^\//, ""),
      },
    );
    assert.equal(
      terminal.route,
      route,
      "Actual terminal must use requested carrier",
    );
    await eventually(
      () => page.evaluate(() => window.actualTerminalLinkState),
      (state) => {
        assert.equal(state.error, null);
        assert.equal(state.closed, null);
        assert.equal(state.ready, true);
      },
    );
    await page.evaluate(
      async ({ terminalId, input }) => {
        const context = {
          surfaceKind: "terminal",
          surfaceId: terminalId,
          operationId: window.actualTerminalLinkOperation,
          direction: "input",
          sequence: 0,
        };
        const protectedData =
          await window.actualTerminalLinkCrypto.protectSurfaceStreamContent({
            context,
            content: { type: "terminal.input", data: input },
            schema: window.actualTerminalLinkSchemas.terminalInputContentSchema,
          });
        if (
          !window.actualTerminalLinkConnection.send({
            type: "input",
            operationId: window.actualTerminalLinkOperation,
            sequence: 0,
            protectedData,
          })
        )
          throw new Error("Actual terminal input rejected");
        await window.actualTerminalLinkConnection.drain();
      },
      { terminalId: terminal.id, input: `node ${program} ${token}\r` },
    );
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
    await eventually(
      () => page.evaluate(() => window.actualTerminalLinkState),
      (state) => {
        assert.equal(state.error, null);
        assert.equal(state.closed, null);
        assert.ok(state.sequence > 0);
        assert.ok(state.output.includes(token));
      },
    );
    await page.evaluate(() =>
      window.actualTerminalLinkConnection.close("normal"),
    );
    await eventually(
      () => requests,
      (values) =>
        assert.ok(
          values.some(
            (r) =>
              r.method === "DELETE" &&
              /\/grants\/[^/]+$/.test(r.path) &&
              r.status === 204,
          ),
        ),
    );
    assert.ok(
      requests.some(
        (r) =>
          new RegExp(`/terminals/${terminal.id}/grant$`).test(r.path) &&
          r.status === 201,
      ),
    );
    result.terminalWorkerLink = {
      route,
      terminalId: terminal.id,
      encryptedInputExecuted: true,
      encryptedOutputOpened: true,
      requests,
    };
    result.steps.push(
      `existing browser terminal transport sends encrypted input through ${route}, executes it in a real PTY and authenticates encrypted output`,
    );
  } finally {
    await page
      .evaluate(() => window.actualTerminalLinkConnection?.close("normal"))
      .catch(() => {});
    page.off("response", response);
  }
}
