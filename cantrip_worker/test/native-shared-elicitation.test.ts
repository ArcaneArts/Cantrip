import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Frame = Record<string, any>;
const question = "Confirm the harmless shared MCP fixture.";
const answer = "SHARED_ELICITATION_DONE";

// A real stdio MCP peer asks the native engine for a user response during its
// tool call. No OAuth URL, external account, browser or desktop is involved.
const mcp = String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input: process.stdin});
const send = (frame) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...frame})+'\n');
let toolId;
rl.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.id === 'fixture-question' && !frame.method) {
    fs.appendFileSync(process.argv[2], JSON.stringify(frame)+'\n');
    send({id:toolId,result:{content:[{type:'text',text:JSON.stringify(frame.result)}],isError:false}});
  } else if (frame.method === 'initialize') {
    send({id:frame.id,result:{protocolVersion:frame.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'shared-elicitation-fixture',version:'1'}}});
  } else if (frame.method === 'tools/list') {
    send({id:frame.id,result:{tools:[{name:'ask',description:'Request harmless fixture confirmation',inputSchema:{type:'object',properties:{}}}]}});
  } else if (frame.method === 'tools/call') {
    toolId = frame.id;
    send({id:'fixture-question',method:'elicitation/create',params:{mode:'form',message:'Confirm the harmless shared MCP fixture.',requestedSchema:{type:'object',properties:{}}}});
  } else if (frame.id !== undefined && frame.method) {
    send({id:frame.id,result:{}});
  }
});
`;

function respond(response: ServerResponse, id: string, item: Frame) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { id: `${id}-item`, ...item } },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe.skipIf(!binary)("shared native MCP elicitation", () => {
  it.each(["gui", "terminal"] as const)(
    "admits each opposite-view reply once for a %s-originated MCP tool and form",
    async (origin) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-elicitation-"),
      );
      const script = path.join(directory, "mcp.cjs");
      const log = path.join(directory, "replies.jsonl");
      await writeFile(script, mcp);
      const requests: Frame[] = [];
      const errors: string[] = [];
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(raw);
        requests.push(body);
        if (requests.length > 1) {
          respond(response, "final", {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer }],
          });
          return;
        }
        const tools = body.tools.flatMap((tool: Frame) =>
          tool.type === "namespace"
            ? tool.tools.map((entry: Frame) => ({
                ...entry,
                namespace: tool.name,
              }))
            : [tool],
        );
        const tool = tools.find((entry: Frame) =>
          /(?:^|__)ask$/.test(entry.name),
        );
        if (!tool) {
          errors.push(`Missing fixture MCP tool: ${JSON.stringify(tools)}`);
          response.writeHead(400).end();
          return;
        }
        respond(response, "ask", {
          type: "function_call",
          call_id: "elicitation-call",
          name: tool.name,
          namespace: tool.namespace,
          arguments: "{}",
        });
      });
      let f:
        Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        f = await createNativeSharedViewFixture(
          binary!,
          `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          {
            mcpServers: [
              {
                name: "elicitation_fixture",
                enabled: true,
                transport: "stdio",
                command: process.execPath,
                args: [script, log],
              },
            ],
          },
        );
        const gui =
          origin === "gui"
            ? await f.guiStart("Run the harmless MCP fixture.")
            : undefined;
        if (!gui) await f.tuiSend("Run the harmless MCP fixture.");
        const reply = {
          kind: "mcpElicitation" as const,
          action: "accept" as const,
          content: {},
          metadata: null,
        };
        const pendingKeys: string[] = [];
        // Native first asks permission to call an unknown MCP tool, then the
        // actual MCP peer requests its own form. Both cross the admitted path.
        for (const [index, message] of [
          'Allow the elicitation_fixture MCP server to run tool "ask"?',
          question,
        ].entries()) {
          await vi.waitFor(
            () => {
              expect(errors).toEqual([]);
              expect(f!.interactionRequests).toHaveLength(index + 1);
              expect(f!.terminalText()).toContain(message);
            },
            { timeout: 15000 },
          );
          const pending = f.interactionRequests[index]!;
          pendingKeys.push(pending.requestKey);
          expect(pending.threadId).toBe(f.threadId);
          expect(pending.payload).toMatchObject({
            kind: "mcpElicitation",
            mode: "form",
            message,
          });
          expect(requests).toHaveLength(1);
          if (gui) f.tuiInput("\r");
          else
            await f.runtime.answerAgentInteraction(pending.requestKey, reply);
          await vi.waitFor(() =>
            expect(f!.interactionCleared).toEqual(pendingKeys),
          );
          await expect(
            f.runtime.answerAgentInteraction(pending.requestKey, reply),
          ).rejects.toThrow("no longer pending");
        }
        const pending = f.interactionRequests[1]!;
        await vi.waitFor(
          () => {
            expect(requests).toHaveLength(2);
            expect(f!.terminalText()).toContain(answer);
            expect(f!.interactionCleared).toEqual(pendingKeys);
          },
          { timeout: 15000 },
        );
        const peerReplies = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(peerReplies).toHaveLength(1);
        expect(peerReplies[0].result).toMatchObject({ action: "accept" });
        expect(JSON.stringify(requests[1].input)).toContain("accept");
        await expect(
          f.runtime.answerAgentInteraction(pending.requestKey, reply),
        ).rejects.toThrow("no longer pending");
        const admitted = f.authority.phases.filter(
          (phase) =>
            phase.phase === "admit" &&
            phase.body.method === "serverRequest/reply",
        );
        expect(admitted).toEqual(
          pendingKeys.map(() =>
            expect.objectContaining({
              status: 200,
              body: expect.objectContaining({
                origin: gui ? "terminal" : "gui",
              }),
            }),
          ),
        );
        if (gui) {
          expect((await gui.settled).error).toBeUndefined();
          await gui.finish();
        } else
          await vi.waitFor(() =>
            expect(f!.completed).toEqual([pending.turnId]),
          );
        expect(f.terminalText()).not.toContain(
          "failed to load skills on startup",
        );
        expect(f.turnFailures).toEqual([]);
        expect(f.terminalSettled()).toBe(false);
      } catch (error) {
        throw new Error(
          `${String(error)}; ${JSON.stringify({ errors, requests: requests.map((body) => body.input.filter((item: Frame) => item.type === "function_call" || item.type === "function_call_output")), pending: f?.interactionRequests, cleared: f?.interactionCleared, screen: f?.terminalText(), fixture: f?.diagnostics() })}`,
          { cause: error },
        );
      } finally {
        await f?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
