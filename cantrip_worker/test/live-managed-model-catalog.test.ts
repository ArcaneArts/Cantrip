import { describe, expect, it, vi } from "vitest";
import { LiveManagedModelCatalog } from "../src/codex/live-managed-model-catalog.js";

const model = (name: string) => ({
  id: name,
  routeId: name,
  name,
  reasoningEffort: null,
});
function fixture() {
  const catalog = new LiveManagedModelCatalog();
  let generation: string | null = "runtime-1";
  catalog.replace(generation, [model("first")], "ollama");
  const dispatch = vi.fn(
    async (params: { revision: string; models: unknown[] }) => ({
      revision: params.revision,
      changed: true,
    }),
  );
  return {
    catalog,
    dispatch,
    setGeneration: (next: string | null) => {
      generation = next;
    },
    sync: (names: string[]) =>
      catalog.synchronize({
        generation: "runtime-1",
        providerKind: "ollama",
        models: names.map(model),
        currentGeneration: () => generation,
        dispatch,
      }),
  };
}

describe("live managed model catalog", () => {
  it("replaces discovered inventory while retaining explicit and currently selected models", async () => {
    const f = fixture();
    f.catalog.replace("runtime-1", [model("explicit")], "ollama", [
      model("A"),
      model("B"),
      model("selected"),
    ]);
    await f.catalog.synchronize({
      generation: "runtime-1",
      providerKind: "ollama",
      models: [],
      inventory: [model("A")],
      retainedModelNames: ["selected"],
      currentGeneration: () => "runtime-1",
      dispatch: f.dispatch,
    });
    expect(
      f.dispatch.mock.calls[0]![0].models.map((entry: any) => entry.slug),
    ).toEqual(["explicit", "selected", "A"]);
    await f.catalog.synchronize({
      generation: "runtime-1",
      providerKind: "ollama",
      models: [],
      inventory: [model("A")],
      retainedModelNames: [],
      currentGeneration: () => "runtime-1",
      dispatch: f.dispatch,
    });
    expect(
      f.dispatch.mock.calls[1]![0].models.map((entry: any) => entry.slug),
    ).toEqual(["explicit", "A"]);
  });

  it("does not replace refreshed metadata with a stale bootstrap model", async () => {
    const f = fixture();
    const metadata = (displayName: string) => ({
      ...model("first"),
      catalog: {
        displayName,
        description: null,
        metadataSource: "unknown" as const,
        contextWindow: null,
        inputModalities: ["text"],
        supportsTools: null,
        supportsParallelTools: null,
        supportsReasoning: null,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
    });
    const synchronize = (
      models: ReturnType<typeof metadata>[],
      inventory?: ReturnType<typeof metadata>[],
    ) =>
      f.catalog.synchronize({
        generation: "runtime-1",
        providerKind: "ollama",
        models,
        inventory,
        currentGeneration: () => "runtime-1",
        dispatch: f.dispatch,
      });
    await synchronize([], [metadata("Fresh")]);
    await synchronize([metadata("Stale")]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]![0].models).toEqual([
      expect.objectContaining({ slug: "first", display_name: "Fresh" }),
    ]);
    await f.catalog.synchronize({
      generation: "runtime-1",
      providerKind: "ollama",
      models: [],
      inventory: [],
      retainedModelNames: ["first"],
      currentGeneration: () => "runtime-1",
      dispatch: f.dispatch,
    });
    // Removing a selected model from inventory retains its last known metadata,
    // even when its explicit bootstrap pin carried an older catalog.
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reuses unchanged startup metadata and serializes updates without losing another thread's model", async () => {
    const f = fixture();
    await f.sync(["first"]);
    expect(f.dispatch).not.toHaveBeenCalled();
    await Promise.all([f.sync(["second"]), f.sync(["third"])]);
    expect(f.dispatch.mock.calls.map(([params]) => params.revision)).toEqual([
      "1",
      "2",
    ]);
    expect(f.dispatch.mock.calls[1]![0].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "first" }),
        expect.objectContaining({ slug: "second" }),
        expect.objectContaining({ slug: "third" }),
      ]),
    );
    await f.sync(["second"]);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed or mismatched acknowledgment and never reuses its revision", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("lost acknowledgment"));
    await expect(f.sync(["second"])).rejects.toThrow("lost acknowledgment");
    f.dispatch.mockResolvedValueOnce({ revision: "wrong", changed: true });
    await expect(f.sync(["second"])).rejects.toThrow("acknowledge");
    await f.sync(["second"]);
    expect(f.dispatch.mock.calls.map(([params]) => params.revision)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("rejects an in-flight old response and queued work after replacement", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.dispatch.mockImplementationOnce(async (params) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { revision: params.revision, changed: true };
    });
    const first = f.sync(["second"]);
    const queued = f.sync(["third"]);
    const results = Promise.allSettled([first, queued]);
    await started;
    f.setGeneration("runtime-2");
    f.catalog.replace("runtime-2", [model("replacement")], "ollama");
    release();
    expect((await results).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains potentially applied models after a lost acknowledgment when a different thread updates", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("lost acknowledgment"));
    await expect(f.sync(["second"])).rejects.toThrow("lost acknowledgment");
    await f.sync(["third"]);
    expect(f.dispatch.mock.calls[1]![0].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "second" }),
        expect.objectContaining({ slug: "third" }),
      ]),
    );
  });

  it("does not replace an account-discovered ChatGPT catalog", async () => {
    const f = fixture();
    await f.catalog.synchronize({
      generation: "runtime-1",
      providerKind: "chatgpt",
      models: [model("second")],
      currentGeneration: () => "runtime-1",
      dispatch: f.dispatch,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
