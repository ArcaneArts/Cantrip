import {
  cantripCliCommandRequestSchema,
  cantripCliCommandResultSchema,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeCantripCliCommand } from "../src/cli-client.js";

const result = cantripCliCommandResultSchema.parse({ summary: "Listed runs." });

function captureRequestBody() {
  let body: unknown = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return () => body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cantrip CLI server client", () => {
  it("omits the default context selection for older strict servers", async () => {
    const requestBody = captureRequestBody();

    await invokeCantripCliCommand({
      request: cantripCliCommandRequestSchema.parse({
        command: "run.list",
        context: { cwd: "/workspace" },
        arguments: {},
      }),
      requestId: "run-list",
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-1",
    });

    expect(requestBody()).toMatchObject({
      command: "run.list",
      context: { cwd: "/workspace" },
    });
    expect(requestBody()).not.toHaveProperty("context.selection");
  });

  it("preserves an explicit context selection", async () => {
    const requestBody = captureRequestBody();

    await invokeCantripCliCommand({
      request: cantripCliCommandRequestSchema.parse({
        command: "run.list",
        context: { cwd: "/workspace", selection: "cwd" },
        arguments: {},
      }),
      requestId: "run-list",
      serverUrl: "https://cantrip.example",
      token: "worker-token",
      workerId: "worker-1",
    });

    expect(requestBody()).toHaveProperty("context.selection", "cwd");
  });
});
