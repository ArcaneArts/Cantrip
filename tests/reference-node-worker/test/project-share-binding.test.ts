import { describe, expect, it } from "vitest";

import { assertProjectShareDestinationBinding } from "../src/project-share-binding.js";

const chatId = "22222222-2222-4222-8222-222222222222";
const rootId = "33333333-3333-4333-8333-333333333333";

function command(standaloneRoot: { chatId: string; rootId: string } | null) {
  return {
    type: "project.share.open" as const,
    shareId: "share-1",
    protectedRecord: {
      version: 1 as const,
      revision: 1,
      operationId: "share-1",
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBB",
      },
    },
    standaloneRoot,
  };
}

const chatDestination = {
  kind: "worker-chat-share" as const,
  workerId: "worker-1",
  resourceId: "share-1",
  chatId,
  rootId,
  publicBasePath: `/project-shares/${"x".repeat(43)}`,
  publicOrigin: "http://127.0.0.1" as const,
  username: "cantrip-chat",
  password: "a-secure-random-password-value",
  realm: "Cantrip Chat Share",
};

describe("project share destination binding", () => {
  it("requires the server-authorized Chat and root identities", () => {
    expect(() =>
      assertProjectShareDestinationBinding(
        command({ chatId, rootId }),
        chatDestination,
        "worker-1",
      ),
    ).not.toThrow();
    expect(() =>
      assertProjectShareDestinationBinding(
        command({
          chatId,
          rootId: "44444444-4444-4444-8444-444444444444",
        }),
        chatDestination,
        "worker-1",
      ),
    ).toThrow("another scratch root");
  });

  it("does not let an ordinary project command open a Chat share", () => {
    expect(() =>
      assertProjectShareDestinationBinding(
        command(null),
        chatDestination,
        "worker-1",
      ),
    ).toThrow("cannot target a standalone Chat root");
  });
});
