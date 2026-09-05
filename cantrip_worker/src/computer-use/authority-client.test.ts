import { cantripMcpBindingSchema } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestComputerUseAuthority } from "./authority-client.js";

function fixture() {
  const binding = cantripMcpBindingSchema.parse({
    bindingId: "00000000-0000-4000-8000-000000000001",
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    contextKind: "project",
    projectId: "project",
    scratchRootId: null,
    worktreeId: "worktree",
    rootKind: "git-worktree",
    executionLaneId: "lane",
    permissionProfileId: ":read-only",
    allowedOperations: ["context.get"],
    issuedAt: "2026-09-05T00:00:00.000Z",
    expiresAt: "2026-09-05T01:00:00.000Z",
  });
  const authority = {
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    serverId: "server",
    contextKind: "project",
    projectId: "project",
    placementId: "worktree",
    executionLaneId: "lane",
    generation: 1,
    profile: {
      selectedId: ":yolo",
      effectiveId: ":read-only",
      usesDefault: false,
      forcedByWorktreePolicy: true,
    },
  };
  const controller = new AbortController();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(authority));
  vi.stubGlobal("fetch", fetcher);
  const call = () =>
    requestComputerUseAuthority({
      binding,
      serverUrl: "https://cantrip.example",
      token: "PRIVATE-credential",
      signal: controller.signal,
    });
  return { binding, authority, controller, fetcher, call };
}
afterEach(() => vi.unstubAllGlobals());

describe("CUA authority client", () => {
  it("calls the worker-authenticated route and preserves selected/effective policy", async () => {
    const f = fixture();
    expect(await f.call()).toEqual(f.authority);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cantrip.example/api/internal/computer-use/authority",
    );
    expect(request).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer PRIVATE-credential" },
    });
    expect(JSON.parse(request!.body as string)).toEqual({ binding: f.binding });
  });
  it("does not cache authority, retry errors, or treat an old permission claim as current policy", async () => {
    const f = fixture();
    expect((await f.call()).generation).toBe(1);
    f.authority.generation = 2;
    f.authority.profile.selectedId = ":workspace";
    expect(await f.call()).toMatchObject({
      generation: 2,
      profile: { selectedId: ":workspace" },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    "ownerId",
    "workerId",
    "chatId",
    "projectId",
    "placementId",
    "executionLaneId",
  ] as const)("rejects a response for a different %s", async (field) => {
    const f = fixture();
    f.authority[field] = "other";
    await expect(f.call()).rejects.toMatchObject({ code: "invalid-response" });
  });
  it.each([401, 409, 404, 500])(
    "reports HTTP %s without publishing server error details or retrying",
    async (status) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(
        Response.json({ error: "PRIVATE-native-details" }, { status }),
      );
      await expect(f.call()).rejects.toMatchObject({
        code: status === 401 || status === 409 ? "unauthorized" : "unavailable",
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects excess/invalid successful response bodies without echoing them", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("PRIVATE".repeat(3000)));
    await expect(f.call()).rejects.toMatchObject({ code: "invalid-response" });
    f.fetcher.mockResolvedValue(
      Response.json({ ...f.authority, privateSecret: "PRIVATE" }),
    );
    await expect(f.call()).rejects.toThrow(
      "The server returned invalid computer-use authority.",
    );
    f.fetcher.mockResolvedValue(new Response("PRIVATE-not-json"));
    await expect(f.call()).rejects.toThrow(
      "The server returned invalid computer-use authority.",
    );
  });
  it("composes caller cancellation into fetch and propagates it without replay", async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetcher.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(options!.signal!.reason),
            { once: true },
          );
          entered();
        }),
    );
    const result = f.call();
    const rejection = expect(result).rejects.toThrow("Stopped");
    await started;
    f.controller.abort(new Error("Stopped"));
    await rejection;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not publish authority when Stop races the final body read", async () => {
    const f = fixture();
    let sent = false;
    f.fetcher.mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify(f.authority)),
                );
              } else {
                f.controller.abort(new Error("Stopped at end of response"));
                controller.close();
              }
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    await expect(f.call()).rejects.toThrow("Stopped at end of response");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains the original attachment snapshot if the broker renews while awaiting a response", async () => {
    const f = fixture();
    let respond!: (response: Response) => void;
    f.fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const result = f.call();
    f.binding.executionLaneId = "renewed-lane";
    respond(Response.json(f.authority));
    expect(await result).toMatchObject({ executionLaneId: "lane" });
  });
  it("makes network failures precise without retaining raw URL/credential errors", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error("PRIVATE url or credential"));
    await expect(f.call()).rejects.toThrow(
      "Computer-use authorization is unavailable.",
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
