// Server-issued capability -> production desktop verifier -> real worker broker.
// Browser crypto protects the terminal payload inside a controlled TCP forwarder.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";
import { directTerminalForwarder } from "./direct-terminal-forwarder.mjs";
import { NativeBrokerClient } from "./native-broker-client.mjs";

export async function actualWorkerTerminalDirect({
  page,
  projectId,
  worktreeId,
  directory,
  result,
  binary,
}) {
  const token = "private-terminal-direct-" + crypto.randomUUID(),
    program = `terminal-direct-${crypto.randomUUID()}.cjs`,
    proof = `terminal-direct-${crypto.randomUUID()}.json`;
  await writeFile(
    path.join(directory, program),
    `require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({token:process.argv[2],pid:process.pid}));console.log(process.argv[2]);\n`,
  );
  const tickets = [],
    checks = [];
  let terminal, forward;
  const release = (id) =>
    page.evaluate(
      async (id) =>
        (await import("/src/lib/api/worker-link.ts")).deleteDirectAttachment(
          id,
        ),
      id,
    );
  const issue = async () => {
    const ticket = await page.evaluate(async (id) => {
      const api = await import("/src/lib/api-client.ts");
      const protocol = await import(
        "/@fs/" + window.actualTerminalDirectProtocolPath
      );
      return protocol.directTunnelTicketSchema.parse(
        await api.post(`/api/terminals/${id}/direct`, {
          clientId: "actual-terminal-direct",
        }),
      );
    }, terminal.id);
    tickets.push(ticket);
    return ticket;
  };
  async function rejected(name, ticket) {
    const probe = new NativeBrokerClient(binary, { kind: "probe", ticket });
    try {
      const value = await probe.ready();
      assert.equal(value.event, "probe");
      assert.equal(value.result.state, "relayed", name);
      assert.ok(value.result.reason);
      checks.push({
        name,
        state: value.result.state,
        reason: value.result.reason,
      });
      return value.result;
    } finally {
      await probe.close();
    }
  }
  try {
    terminal = await page.evaluate(
      async ({ projectId, worktreeId, protocolPath }) => {
        window.actualTerminalDirectProtocolPath = protocolPath;
        return await (
          await import("/src/lib/api/terminals.ts")
        ).createTerminal(projectId, "Private direct terminal", worktreeId);
      },
      {
        projectId,
        worktreeId,
        protocolPath: path
          .join(repositoryRoot, "packages/protocol/src/index.ts")
          .replaceAll("\\", "/")
          .replace(/^\//, ""),
      },
    );
    const ticket = await issue();
    assert.equal(ticket.binding.resourceKind, "terminal");
    assert.equal(ticket.binding.resourceId, terminal.id);
    assert.deepEqual(ticket.binding.channels, ["tunnel-data"]);
    forward = await directTerminalForwarder(binary, ticket);
    await page.evaluate(
      async ({ id, port }) => {
        const crypto = await import("/src/lib/surface-stream-encryption.ts"),
          protocol = await import(
            "/@fs/" + window.actualTerminalDirectProtocolPath
          );
        const operationId = globalThis.crypto.randomUUID(),
          socket = new WebSocket(
            `ws://127.0.0.1:${port}/terminal?operationId=${operationId}`,
          );
        const state = (window.actualTerminalDirect = {
          socket,
          operationId,
          terminalId: id,
          crypto,
          protocol,
          ready: false,
          closed: null,
          error: null,
          errors: [],
          output: "",
          sequence: 0,
          pending: Promise.resolve(),
        });
        socket.onclose = (event) => {
          state.closed = { code: event.code, reason: event.reason };
        };
        socket.onerror = () => {
          state.error = "Direct terminal WebSocket transport failed";
        };
        socket.onmessage = (event) => {
          state.pending = state.pending
            .then(async () => {
              const message = protocol.terminalServerMessageSchema.parse(
                JSON.parse(event.data),
              );
              if (message.type === "ready") state.ready = true;
              else if (message.type === "error")
                state.errors.push(message.message);
              else if (message.type === "output") {
                if (
                  message.operationId !== operationId ||
                  message.sequence !== state.sequence
                )
                  throw new Error("Direct terminal output sequence mismatch");
                state.sequence++;
                const content = await crypto.openSurfaceStreamContent({
                  context: {
                    surfaceKind: "terminal",
                    surfaceId: id,
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
      },
      { id: terminal.id, port: forward.port },
    );
    const state = () =>
      page.evaluate(async () => {
        const s = window.actualTerminalDirect;
        await s.pending;
        return {
          ready: s.ready,
          closed: s.closed,
          error: s.error,
          errors: s.errors,
          output: s.output,
          sequence: s.sequence,
        };
      });
    await eventually(state, (s) => {
      forward.check();
      assert.equal(s.error, null);
      assert.equal(s.closed, null);
      assert.equal(s.ready, true);
    });
    const command = `node ${program} ${token}\r`;
    await page.evaluate(async (input) => {
      const s = window.actualTerminalDirect;
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
      s.input = {
        type: "input",
        operationId: s.operationId,
        sequence: 0,
        protectedData,
      };
      s.socket.send(
        JSON.stringify(
          s.protocol.terminalClientMessageSchema.parse({
            ...s.input,
            operationId: "wrong-direct-operation",
          }),
        ),
      );
    }, command);
    await eventually(state, (s) => {
      forward.check();
      assert.equal(s.error, null);
      assert.deepEqual(s.errors, ["Invalid protected terminal message."]);
    });
    await assert.rejects(readFile(path.join(directory, proof)), {
      code: "ENOENT",
    });
    checks.push({
      name: "wrong terminal operation rejected before execution",
      rejected: true,
    });
    await page.evaluate(() => {
      const s = window.actualTerminalDirect;
      s.socket.send(
        JSON.stringify(s.protocol.terminalClientMessageSchema.parse(s.input)),
      );
    });
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
      forward.check();
      assert.equal(s.error, null);
      assert.equal(s.closed, null);
      assert.ok(s.sequence > 0);
      assert.ok(s.output.includes(token));
    });
    const wire = Buffer.concat([
      ...forward.carrier.sentFrames,
      ...forward.carrier.frames,
    ]);
    for (const value of [token, command, directory])
      assert.equal(
        wire.includes(Buffer.from(value)),
        false,
        "terminal content remains opaque in broker/tunnel frames",
      );
    checks.push({
      name: "authenticated encrypted input/output through real broker and PTY",
      inputExecuted: true,
      outputAuthenticated: true,
    });
    await rejected(
      "one-use terminal capability secret cannot reconnect",
      ticket,
    );
    await release(ticket.binding.capabilityId);
    await eventually(
      () => forward.carrier.closed,
      (value) =>
        assert.deepEqual(value, {
          event: "closed",
          code: 1008,
          reason: "Client released direct attachment",
        }),
    );
    await eventually(state, (s) => assert.ok(s.closed));
    checks.push({
      name: "completed server revocation interrupts active native broker",
      code: forward.carrier.closed.code,
    });
    const revoked = await issue();
    await release(revoked.binding.capabilityId);
    await rejected("revoked terminal capability cannot initialize", revoked);
    const wrongIdentity = await issue();
    const rejectedIdentity = await rejected(
      "mismatched terminal broker identity rejected",
      {
        ...wrongIdentity,
        broker: { ...wrongIdentity.broker, fingerprint: "0".repeat(64) },
      },
    );
    assert.match(rejectedIdentity.reason, /identity did not match/u);
    result.terminalDirectData = {
      productionDesktopVerifier: true,
      controlledTcpForwarder: true,
      tauriIpc: false,
      packagedDesktop: false,
      verified: forward.verified,
      frames: forward.observations,
      checks,
    };
    result.steps.push(
      "native desktop verifier authenticates the real terminal broker; endpoint-encrypted input executes in a PTY and ordered output authenticates in the browser",
    );
    result.steps.push(
      "terminal direct transport rejects wrong operations, one-use secret replay, revoked capabilities and mismatched broker identity; completed revocation interrupts the active broker",
    );
  } finally {
    if (forward)
      result.terminalDirectDataEvidence = {
        verified: forward.verified,
        frames: forward.observations,
        events: forward.carrier.events,
        checks,
      };
    await page
      .evaluate(() => window.actualTerminalDirect?.socket.close(1000))
      .catch(() => {});
    for (const ticket of tickets) {
      ticket.secret = "";
      await release(ticket.binding.capabilityId).catch(() => {});
    }
    await forward?.close();
    if (terminal)
      await page.evaluate(
        async (id) =>
          (await import("/src/lib/api/terminals.ts")).deleteTerminal(id),
        terminal.id,
      );
  }
}
