import { describe, expect, it, vi } from "vitest";
import { ManagedNativeQueueCutover } from "../src/codex/managed-native-queue-cutover.js";

const identity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project" as const,
  placementId: "placement",
  threadId: "thread",
  runtimeGeneration: "runtime",
  modelRouteId: "route",
  providerAccountId: null,
};
const session = { ...identity, connectionId: "owner" };
const encryption = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: (_scope: string, revision = 1) => ({
    key: new Uint8Array(32).fill(12),
    keyRevision: revision,
  }),
};
const source = {
  id: "legacy",
  input: [
    { type: "text", text: "!this remains literal" },
    { type: "image", url: "https://fixture/image" },
  ],
  clientUserMessageId: "native-client",
};
function fixture() {
  let sources = [source];
  const records: any[] = [];
  const items: any[] = [];
  const snapshot = () => ({
    revision: items.length,
    paused: false,
    items: [...items],
    claims: [],
  });
  const deleted = new Map<string, any>();
  const runtime = {
    readManagedNativeQueue: vi.fn(async () => sources),
    deleteManagedNativeQueue: vi.fn(async (params: any) => {
      if (deleted.has(params.operationId))
        return deleted.get(params.operationId);
      sources = [];
      const receipt = { deleted: true, conflict: false };
      deleted.set(params.operationId, receipt);
      return receipt;
    }),
  };
  const client = {
    import: vi.fn(async ({ items: incoming }: any) => {
      for (const input of incoming)
        records.push({
          ...input,
          promptId: input.prompt.id,
          importId: "import",
          status: "pending",
          nativeDeleteOperationId: "delete:import",
        });
      return {
        ...snapshot(),
        imports: records.filter((record) => record.status !== "imported"),
      };
    }),
    acknowledgeImport: vi.fn(async ({ receipt }: any) => {
      records[0].status = receipt.deleted
        ? "imported"
        : receipt.conflict
          ? "conflict"
          : "uncertain";
      if (receipt.deleted) items.push(records[0].prompt);
      return snapshot();
    }),
  };
  const preparePrompt = vi.fn(async ({ id, request }: any) => ({
    prompt: { id, input: request.params.input },
    attachments: [],
  }));
  const observe = vi.fn();
  const create = () =>
    new ManagedNativeQueueCutover({
      identity,
      session: () => session,
      runnerGeneration: () => "runner",
      signal: () => new AbortController().signal,
      assertCurrent() {},
      encryption,
      runtime,
      client: client as any,
      preparePrompt: preparePrompt as any,
      observe,
    });
  return { create, runtime, client, preparePrompt, records, items, observe };
}

describe("legacy native queue cutover", () => {
  it("stages exact literal input and publishes it only after the durable compare-delete receipt", async () => {
    const f = fixture();
    await f.create().synchronize();
    expect(f.preparePrompt.mock.calls[0]![0].request.params).toMatchObject({
      input: source.input,
      clientUserMessageId: "native-client",
      managed: { action: "literal" },
    });
    expect(f.runtime.deleteManagedNativeQueue.mock.calls[0]![0]).toMatchObject({
      queuedSubmissionId: "legacy",
      expectedInput: source.input,
      expectedClientUserMessageId: "native-client",
      operationId: "delete:import",
    });
    expect(f.observe.mock.calls[0]![0].items).toEqual([]);
    expect(f.items).toHaveLength(1);
    expect(
      JSON.stringify(
        f.client.import.mock.calls[1]![0].items[0].protectedSource,
      ),
    ).not.toContain("this remains literal");
  });

  it("recovers native delete commit followed by lost canonical ACK after worker recreation", async () => {
    const f = fixture();
    const acknowledge = f.client.acknowledgeImport.getMockImplementation()!;
    f.client.acknowledgeImport.mockRejectedValueOnce(new Error("ACK lost"));
    await expect(f.create().synchronize()).rejects.toThrow("ACK lost");
    expect(f.items).toEqual([]);
    expect(await f.runtime.readManagedNativeQueue()).toEqual([]);
    f.client.acknowledgeImport.mockImplementation(acknowledge);
    await f.create().synchronize();
    expect(f.items).toHaveLength(1);
    expect(
      f.runtime.deleteManagedNativeQueue.mock.calls.map(
        ([params]) => params.operationId,
      ),
    ).toEqual(["delete:import", "delete:import"]);
    expect(f.preparePrompt).toHaveBeenCalledOnce();
  });

  it.each([
    { deleted: false, conflict: true },
    { deleted: false, conflict: false },
  ])("does not activate an unconfirmed source: %j", async (receipt) => {
    const f = fixture();
    f.runtime.deleteManagedNativeQueue.mockResolvedValue(receipt);
    await f.create().synchronize();
    expect(f.items).toEqual([]);
    expect(f.records[0].status).toBe(
      receipt.conflict ? "conflict" : "uncertain",
    );
  });
});
