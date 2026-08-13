import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createServerLogStream } from "../src/logger.js";

describe("server logging", () => {
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
});
