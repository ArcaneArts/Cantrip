import { randomBytes, randomUUID } from "node:crypto";

import type { CodeSettingsUpload } from "@cantrip/protocol/code-settings";
import { describe, expect, it } from "vitest";

import {
  CodeSettingsClient,
  CodeSettingsClientConflictError,
  CodeSettingsClientError,
} from "./code-settings-client.js";

function upload(): CodeSettingsUpload {
  return {
    expectedRevision: null,
    record: {
      operationId: randomUUID(),
      revision: 1,
      protectedContent: {
        formatVersion: 1,
        domain: "customization-content",
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: randomBytes(12).toString("base64url"),
          ciphertext: randomBytes(32).toString("base64url"),
        },
      },
    },
  };
}

describe("Code settings server client", () => {
  it("authenticates requests and treats only GET 404 as uninitialized", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = new CodeSettingsClient({
      credential: () => "secret-worker-token",
      fetch: (async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify({ error: "missing" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      profileId: "default",
      serverUrl: "https://cantrip.test",
      workerId: "worker/with spaces",
    });
    await expect(client.get()).resolves.toBeNull();
    expect(requests[0]?.input).toContain("worker%2Fwith%20spaces");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret-worker-token",
    });
  });

  it("returns typed sanitized conflicts and transport failures", async () => {
    const conflictClient = new CodeSettingsClient({
      credential: () => "token",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            code: "revision-conflict",
            profileId: "default",
            currentRevision: 7,
            error: "changed",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      profileId: "default",
      serverUrl: "https://cantrip.test",
      workerId: "worker",
    });
    await expect(conflictClient.put(upload())).rejects.toMatchObject({
      currentRevision: 7,
      name: CodeSettingsClientConflictError.name,
    });

    const offlineClient = new CodeSettingsClient({
      credential: () => "token",
      fetch: (async () => {
        throw new Error("GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL");
      }) as typeof fetch,
      profileId: "default",
      serverUrl: "https://cantrip.test",
      workerId: "worker",
    });
    const failure = await offlineClient.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodeSettingsClientError);
    expect(String(failure)).not.toContain(
      "GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL",
    );
  });
});
