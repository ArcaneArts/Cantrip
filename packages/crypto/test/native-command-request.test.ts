import { describe, expect, it } from "vitest";
import { protectNativeCommandContent } from "../../../cantrip_worker/src/native-command-content.js";
import { decryptNativeCommandRequest } from "../src/native-command-request.js";

const material = () => ({
  ownerId: "owner",
  serverId: "server",
  componentKey: new Uint8Array(32).fill(19),
  keyRevision: 2,
  chatId: "chat",
  operationId: "operation",
});
const frame = {
  id: 1,
  method: "thread/settings/update",
  params: { threadId: "thread", serviceTier: null, effort: "high" },
};
async function encrypted() {
  return protectNativeCommandContent({
    service: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({ key: material().componentKey, keyRevision: 2 }),
    },
    context: { chatId: "chat", operationId: "operation", direction: "request" },
    content: frame,
  });
}
describe("browser native request decryption compatibility", () => {
  it("opens the real worker admission envelope without changing the caller's key", async () => {
    const input = material();
    expect(
      await decryptNativeCommandRequest({
        ...input,
        envelope: (await encrypted()).envelope,
      }),
    ).toEqual(frame);
    expect(input.componentKey.every((byte) => byte === 19)).toBe(true);
  });
  it.each(["ownerId", "serverId", "chatId", "operationId"] as const)(
    "authenticates %s",
    async (field) => {
      await expect(
        decryptNativeCommandRequest({
          ...material(),
          [field]: "different",
          envelope: (await encrypted()).envelope,
        }),
      ).rejects.toThrow();
    },
  );
});
