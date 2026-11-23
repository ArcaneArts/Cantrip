import { describe, expect, it } from "vitest";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../src/native-command-content.js";

const context = {
  chatId: "chat-1",
  operationId: "operation-1",
  direction: "request" as const,
};
const key = new Uint8Array(32).fill(17);
function service(owner = "owner-1", server = "server-1") {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = 3) => {
      if (revision !== 3) throw new Error("Unavailable revision");
      return { key: key.slice(), keyRevision: revision };
    },
  };
}

describe("protected native command admission", () => {
  it("round trips protected RPC without publishing a raw or guessable digest", async () => {
    const content = {
      method: "turn/start",
      params: { input: [{ text: "private prompt" }] },
    };
    const first = await protectNativeCommandContent({
      service: service(),
      context,
      content,
    });
    const second = await protectNativeCommandContent({
      service: service(),
      context,
      content,
    });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
    expect(first.envelope.nonce).not.toBe(second.envelope.nonce);
    expect(JSON.stringify(first)).not.toContain("private prompt");
    expect(
      await openNativeCommandContent({
        service: service(),
        context,
        envelope: first.envelope,
      }),
    ).toEqual(content);
    expect(key).toEqual(new Uint8Array(32).fill(17));
  });

  it.each([
    { chatId: "other" },
    { operationId: "other" },
    { direction: "result" as const },
  ])("rejects substitution across command context %j", async (change) => {
    const sealed = await protectNativeCommandContent({
      service: service(),
      context,
      content: { answer: "yes" },
    });
    await expect(
      openNativeCommandContent({
        service: service(),
        context: { ...context, ...change },
        envelope: sealed.envelope,
      }),
    ).rejects.toThrow("could not be authenticated");
  });

  it("binds content to owner and logical server even if key bytes match", async () => {
    const sealed = await protectNativeCommandContent({
      service: service(),
      context,
      content: "answer",
    });
    for (const other of [service("other"), service("owner-1", "other")]) {
      await expect(
        openNativeCommandContent({
          service: other,
          context,
          envelope: sealed.envelope,
        }),
      ).rejects.toThrow();
    }
  });

  it("does not allow an RPC acknowledgment to substitute for terminal evidence", async () => {
    const sealed = await protectNativeCommandContent({
      service: service(),
      context: { ...context, direction: "result" },
      content: { turn: { id: "turn-1" } },
    });
    await expect(
      openNativeCommandContent({
        service: service(),
        context: { ...context, direction: "terminal-result" },
        envelope: sealed.envelope,
      }),
    ).rejects.toThrow("could not be authenticated");
  });

  it("detects tampering and selects the recorded key revision", async () => {
    const sealed = await protectNativeCommandContent({
      service: service(),
      context,
      content: { result: 42 },
    });
    await expect(
      openNativeCommandContent({
        service: service(),
        context,
        envelope: {
          ...sealed.envelope,
          ciphertext: `${sealed.envelope.ciphertext[0] === "A" ? "B" : "A"}${sealed.envelope.ciphertext.slice(1)}`,
        },
      }),
    ).rejects.toThrow();
    await expect(
      openNativeCommandContent({
        service: service(),
        context,
        envelope: {
          ...sealed.envelope,
          keyRevision: 4,
        },
      }),
    ).rejects.toThrow("Unavailable revision");
  });
});
