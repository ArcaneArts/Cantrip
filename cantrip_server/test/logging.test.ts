import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  createServerLogStream,
  SERVER_LOG_REDACTION_PATHS,
} from "../src/logger.js";

describe("server logging", () => {
  it("treats policy summaries and bodies as redacted request fields", () => {
    expect(SERVER_LOG_REDACTION_PATHS).toEqual(
      expect.arrayContaining(["req.body.summary", "req.body.bodyMarkdown"]),
    );
  });

  it("treats Task planning artifacts as redacted request fields", () => {
    expect(SERVER_LOG_REDACTION_PATHS).toEqual(
      expect.arrayContaining([
        "req.body.briefMarkdown",
        "req.body.planMarkdown",
        "req.body.finalPlanMarkdown",
        "req.body.goalPrompt",
        "req.body.questions",
        "req.body.answers",
        "req.body.additionalDirection",
      ]),
    );
  });

  it("treats global Code settings payloads as redacted request fields", () => {
    expect(SERVER_LOG_REDACTION_PATHS).toEqual(
      expect.arrayContaining([
        "req.body.protectedContent",
        "req.body.record.protectedContent",
        "req.body.settings",
      ]),
    );
  });

  it("renders Fastify requests as one concise completion line", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        stream: createServerLogStream({
          colors: false,
          output: (line) => lines.push(line),
        }),
      },
    });
    app.get("/requested/path", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/requested/path",
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[server\] \d{2}:\d{2}: GET \/requested\/path -> 200 OK \((?:\d+µs|\d+ms)\)$/u,
    );
    expect(lines[0]).not.toMatch(/hostname|pid|reqId|request completed/u);
  });

  it("fans the same query-free request event to console and service storage", async () => {
    const lines: string[] = [];
    const records: Array<{
      context?: unknown;
      level: string;
      message: string;
      system: string;
    }> = [];
    const app = Fastify({
      logger: {
        stream: createServerLogStream({
          colors: false,
          output: (line) => lines.push(line),
          onRecord: (record) => records.push(record),
        }),
      },
    });
    app.get("/api/projects/:projectId/chats", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project-one/chats?access_token=unsafe&cursor=5",
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(records).toMatchObject([
      {
        system: "server",
        level: "info",
        message: expect.stringContaining(
          "GET /api/projects/project-one/chats -> 200 OK",
        ),
        context: expect.objectContaining({
          event: "http.request.completed",
          operation: "GET",
          status: "completed",
          subsystem: "http",
        }),
      },
    ]);
    expect(JSON.stringify({ lines, records })).not.toContain("unsafe");
    expect(lines[0]).toContain(records[0]!.message);
  });
});
