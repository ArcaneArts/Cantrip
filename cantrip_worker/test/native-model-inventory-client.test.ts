import { describe, expect, it, vi } from "vitest";
import { NativeModelInventoryClient } from "../src/native-model-inventory-client.js";
import type { NativeModelInventory } from "@cantrip/protocol";

const inventory: NativeModelInventory = {
  workerId: "worker",
  providerId: "provider",
  providerAccountId: "account",
  providerKind: "chatgpt",
  models: [
    { id: "logical", routeId: "route", name: "native", reasoningEffort: null },
  ],
};
const provider = {
  id: "provider",
  kind: "chatgpt" as const,
  accountId: "account",
};

describe("native model inventory transport", () => {
  it("uses the current credential and exact worker/provider/account scope", async () => {
    const requests: Array<{ input: unknown; init?: RequestInit }> = [];
    let token = "first-token";
    const client = new NativeModelInventoryClient({
      serverUrl: "https://server.invalid",
      workerId: "worker",
      token: () => token,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return Response.json(inventory);
      },
    });
    expect(await client.read(provider)).toEqual(inventory);
    token = "rotated-token";
    await client.read(provider);
    expect(
      requests.map((request) =>
        new Headers(request.init?.headers).get("authorization"),
      ),
    ).toEqual(["Bearer first-token", "Bearer rotated-token"]);
    expect(String(requests[0]!.input)).toBe(
      "https://server.invalid/api/internal/native-model-inventory",
    );
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({
      workerId: "worker",
      providerId: "provider",
      providerAccountId: "account",
    });
    expect(requests[0]!.init?.redirect).toBe("error");
  });

  it.each([
    { workerId: "other-worker" },
    { providerId: "other-provider" },
    { providerAccountId: "other-account" },
    { providerKind: "grok" },
  ])("rejects mismatched inventory scope: %j", async (change) => {
    const client = new NativeModelInventoryClient({
      serverUrl: "https://server.invalid",
      workerId: "worker",
      token: () => "token",
      fetch: async () => Response.json({ ...inventory, ...change }),
    });
    await expect(client.read(provider)).rejects.toThrow(
      "another provider/account scope",
    );
  });

  it("reports HTTP failure without leaking response bodies or retrying operations", async () => {
    const fetch = vi.fn(
      async () => new Response("private upstream diagnostic", { status: 503 }),
    );
    const client = new NativeModelInventoryClient({
      serverUrl: "https://server.invalid",
      workerId: "worker",
      token: () => "token",
      fetch,
    });
    await expect(client.read(provider)).rejects.toThrow(
      "Native model inventory returned HTTP 503.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
