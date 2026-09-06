import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { MockAgent } from "undici";
import type { CantripMcpConnectionDocument } from "@cantrip/protocol";

const fixture = vi.hoisted(() => ({ agent: null as MockAgent | null }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    // Exercise real fetch/dispatcher callbacks; replace only network delivery.
    Agent: class extends actual.MockAgent {
      constructor() {
        super();
        this.disableNetConnect();
        fixture.agent = this;
      }
    },
  };
});
import {
  invokeCuaMcpBrokerOperation,
  verifyCantripMcpConnection,
} from "../src/mcp/connection.js";

const document = {
  endpoint: "http://127.0.0.1:47821",
  bindingId: "582af12e-2b5b-449f-9ea9-fb555c18c847",
  credential: "test-only",
  protocolVersion: 1,
  expiresAt: "2099-01-01T00:00:00Z",
} as CantripMcpConnectionDocument;
const request = {
  operation: "js" as const,
  script: "await cua.help()",
  threadId: "thread",
  turnId: "turn",
  itemId: null,
  callId: null,
};
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  fixture.agent!.assertNoPendingInterceptors();
  await fixture.agent!.close();
});

describe("CUA fetch/dispatcher compatibility", () => {
  it("receives CUA help over the real packaged HTTP callback contract", async () => {
    let posted: unknown;
    fixture
      .agent!.get(document.endpoint)
      .intercept({
        path: "/v1/computer-use",
        method: "POST",
        headers: { authorization: "Bearer test-only" },
      })
      .reply(200, (options) => {
        posted = JSON.parse(String(options.body));
        return { content: [{ type: "text", text: "API version 3" }] };
      });
    await expect(
      invokeCuaMcpBrokerOperation(
        document,
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "API version 3" }],
    });
    expect(posted).toEqual({ bindingId: document.bindingId, request });
  }, 1500);

  it("preserves broker errors instead of replacing them with fetch failed", async () => {
    fixture
      .agent!.get(document.endpoint)
      .intercept({ path: "/v1/computer-use", method: "POST" })
      .reply(409, { error: "The binding expired." });
    await expect(
      invokeCuaMcpBrokerOperation(
        document,
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("The binding expired.");
  }, 1500);

  it("keeps generic broker handshakes on the existing fetch path", async () => {
    const ordinaryFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: document.protocolVersion,
          bindingId: document.bindingId,
          expiresAt: document.expiresAt,
        }),
      ),
    );
    await verifyCantripMcpConnection(document);
    expect(ordinaryFetch).toHaveBeenCalledOnce();
    expect(ordinaryFetch.mock.calls[0]![1]).not.toHaveProperty("dispatcher");
  });
});
