import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRpcClient } from "../src/codex/rpc-client.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

// Actual pinned executable, isolated home and synthetic local provider. No
// account credentials, inference charges, GUI input, or existing sessions.
describe.skipIf(!binary)("native stateless labeling", () => {
  it("uses one small request without tools, project instructions, or durable threads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-label-inference-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const bodies: Record<string, any>[] = [];
    const authorizations: Array<string | undefined> = [];
    let fail = false;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      authorizations.push(request.headers.authorization);
      if (fail) {
        response.writeHead(500).end("Synthetic provider failure");
        return;
      }
      const id = `response-${bodies.length}`;
      const item =
        bodies.length === 2
          ? {
              type: "agent_message",
              id: "amsg_fixture",
              author: "assistant",
              recipient: "all",
              content: [{ type: "input_text", text: "Fix login form" }],
            }
          : {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              content: [{ type: "output_text", text: "Fix login form" }],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id,
            usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          },
        },
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    let client: CodexRpcClient | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      await Promise.all([mkdir(home), mkdir(cwd)]);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No provider address");
      const catalog = JSON.parse(
        await readFile(
          new URL(
            "../../cantrip_codex/upstream/codex-rs/models-manager/models.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const model = {
        ...catalog.models[0],
        slug: "gpt-5",
        use_responses_lite: false,
        prefer_websockets: false,
        tool_mode: null,
        upgrade: null,
      };
      const catalogPath = path.join(root, "catalog.json");
      await writeFile(catalogPath, JSON.stringify({ models: [model] }));
      await writeFile(
        path.join(cwd, "AGENTS.md"),
        "PROJECT_INSTRUCTION_MUST_NOT_BE_SENT",
      );
      await writeFile(
        path.join(home, "AGENTS.md"),
        "GLOBAL_INSTRUCTION_MUST_NOT_BE_SENT",
      );
      await writeFile(
        path.join(home, "config.toml"),
        [
          'model = "gpt-5"',
          'model_provider = "label_fixture"',
          "features.plugins = false",
          'approval_policy = "never"',
          'sandbox_mode = "read-only"',
          `model_catalog_json = ${JSON.stringify(catalogPath)}`,
          "[model_providers.label_fixture]",
          'name = "Label fixture"',
          `base_url = "http://127.0.0.1:${address.port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          'env_key = "LABEL_FIXTURE_KEY"',
          "request_max_retries = 0",
          "stream_max_retries = 0",
          "[mcp_servers.forbidden]",
          'command = "/does/not/exist"',
          "required = true",
        ].join("\n"),
      );
      const child = spawn(binary!, ["app-server"], {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: home,
          LABEL_FIXTURE_KEY: "synthetic-fixture-key",
        },
        stdio: "pipe",
      });
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      stop = async () => {
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        try {
          client?.close();
          await closed;
        } finally {
          clearTimeout(force);
        }
      };
      client = new CodexRpcClient(child, 15_000);
      const initialized = await client.request("initialize", {
        clientInfo: { name: "cantrip_label_test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized.error).toBeUndefined();
      client.notify("initialized");
      const list = async () => {
        const response = await client!.request("thread/list", {});
        expect(
          response.error,
          `native labeling request ${bodies.length}`,
        ).toBeUndefined();
        return (response.result as { data: unknown[] }).data;
      };
      expect(await list()).toEqual([]);
      for (const input of ["Repair login fields", "Repair login validation"]) {
        const response = await client.request("cantrip/inference", {
          model: "gpt-5",
          instructions: "Return only a three-word title.",
          input,
          reasoningEffort: "low",
        });
        expect(
          response.error,
          `native labeling request ${bodies.length}`,
        ).toBeUndefined();
        expect(response.result).toEqual({ text: "Fix login form" });
      }
      expect(bodies).toHaveLength(2);
      for (const [index, body] of bodies.entries()) {
        expect(body.model).toBe("gpt-5");
        expect(body.tools).toEqual([]);
        expect(body.instructions).toBe("Return only a three-word title.");
        expect(body.input).toHaveLength(1);
        expect(JSON.stringify(body.input)).toContain(
          index === 0 ? "Repair login fields" : "Repair login validation",
        );
        expect(JSON.stringify(body)).not.toMatch(
          /INSTRUCTION_MUST_NOT_BE_SENT|You are Codex|forbidden/,
        );
        expect(body.reasoning.effort).toBe("low");
      }
      expect(authorizations).toEqual([
        "Bearer synthetic-fixture-key",
        "Bearer synthetic-fixture-key",
      ]);
      expect(await list()).toEqual([]);
      expect(
        await readdir(path.join(home, "sessions")).catch(() => []),
      ).toEqual([]);
      const invalid = await client.request("cantrip/inference", {
        model: "gpt-5",
        instructions: "Title",
        input: "x".repeat(24_001),
      });
      expect(invalid.error?.code).toBe(-32602);
      expect(bodies).toHaveLength(2);
      fail = true;
      const failed = await client.request("cantrip/inference", {
        model: "gpt-5",
        instructions: "Title",
        input: "Private request",
      });
      expect(failed.error).toBeDefined();
      expect(failed.error?.message).not.toContain("Private request");
      expect(await list()).toEqual([]);
    } finally {
      await stop?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
