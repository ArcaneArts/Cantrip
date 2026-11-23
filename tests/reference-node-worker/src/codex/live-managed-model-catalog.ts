import {
  codexCatalogForRuntimeModels,
  managedCatalogModels,
} from "./model-catalog.js";
import type { RunAgentTurnOptions } from "./app-server.js";

type RuntimeModel = RunAgentTurnOptions["model"];
type Catalog = NonNullable<ReturnType<typeof codexCatalogForRuntimeModels>>;

/** Acknowledged process-local catalog updates, serialized independently of turns. */
export class LiveManagedModelCatalog {
  private state: {
    generation: string;
    revision: bigint;
    fingerprint: string | null;
    models: Map<string, RuntimeModel>;
    inventory: Map<string, RuntimeModel>;
    retainedModels: Map<string, RuntimeModel>;
    queue: Promise<void>;
  } | null = null;

  replace(
    generation: string,
    models: readonly RuntimeModel[],
    providerKind: RunAgentTurnOptions["provider"]["kind"],
    inventory: readonly RuntimeModel[] = [],
  ): void {
    const catalog = codexCatalogForRuntimeModels(
      managedCatalogModels(models, inventory),
      providerKind,
    );
    this.state = {
      generation,
      revision: 0n,
      fingerprint: catalog ? JSON.stringify(catalog.models) : null,
      models: new Map(
        managedCatalogModels(models, []).map((model) => [model.name, model]),
      ),
      inventory: new Map(
        managedCatalogModels([], inventory).map((model) => [model.name, model]),
      ),
      retainedModels: new Map(),
      queue: Promise.resolve(),
    };
  }

  clear(): void {
    this.state = null;
  }

  synchronize(options: {
    generation: string;
    models: readonly RuntimeModel[];
    /** A successful discovery replaces the previous inventory, including removals. */
    inventory?: readonly RuntimeModel[];
    /** Keep metadata used by currently selected/pending native threads. */
    retainedModelNames?: readonly string[];
    providerKind: RunAgentTurnOptions["provider"]["kind"];
    currentGeneration(): string | null;
    dispatch(params: {
      revision: string;
      models: Catalog["models"];
    }): Promise<unknown>;
  }): Promise<void> {
    // Native account discovery owns ChatGPT's catalog.
    if (options.providerKind === "chatgpt") return Promise.resolve();
    const state = this.state;
    const assertCurrent = () => {
      if (
        !state ||
        this.state !== state ||
        state.generation !== options.generation ||
        options.currentGeneration() !== options.generation
      )
        throw new Error("Codex runtime changed during managed catalog update.");
    };
    const work = (state?.queue ?? Promise.resolve()).then(async () => {
      assertCurrent();
      const nextModels = new Map(state!.models);
      const retainedModels =
        options.retainedModelNames === undefined
          ? state!.retainedModels
          : new Map<string, RuntimeModel>();
      for (const name of options.retainedModelNames ?? []) {
        const known =
          state!.inventory.get(name) ?? state!.retainedModels.get(name);
        if (known) retainedModels.set(name, known);
      }
      // Keep explicit models used by other live threads when a discovery read
      // is unavailable. Replace metadata for each newly supplied model.
      for (const model of options.models) {
        const previous = nextModels.get(model.name);
        nextModels.set(
          model.name,
          !model.catalog && previous?.catalog
            ? { ...model, catalog: previous.catalog }
            : model,
        );
      }
      const inventory =
        options.inventory === undefined
          ? state!.inventory
          : new Map(
              managedCatalogModels([], options.inventory).map((model) => [
                model.name,
                model,
              ]),
            );
      const catalog = codexCatalogForRuntimeModels(
        // Discovery is authoritative metadata. Bootstrap pins only supply
        // models missing from discovery; stale turns cannot roll it backward.
        managedCatalogModels(
          managedCatalogModels(
            [...nextModels.values()],
            [...retainedModels.values()],
          ),
          [...inventory.values()],
        ),
        options.providerKind,
      );
      if (!catalog) return;
      const fingerprint = JSON.stringify(catalog.models);
      // This is candidate inventory, not an applied receipt. Retain it even if
      // acknowledgment is lost: the native catalog may already expose these
      // models to another live thread before a later replacement is requested.
      state!.models = nextModels;
      state!.inventory = inventory;
      state!.retainedModels = retainedModels;
      if (state!.fingerprint === fingerprint) return;
      // Advance on dispatch, including uncertain acknowledgments: never reuse
      // a revision for different content after transport failure.
      const revision = String(++state!.revision);
      const result = await options.dispatch({
        revision,
        models: catalog.models,
      });
      assertCurrent();
      if (
        !result ||
        typeof result !== "object" ||
        !("revision" in result) ||
        result.revision !== revision ||
        !("changed" in result) ||
        typeof result.changed !== "boolean"
      )
        throw new Error(
          "Codex did not acknowledge the managed catalog revision.",
        );
      state!.fingerprint = fingerprint;
    });
    if (state) state.queue = work.catch(() => {});
    return work;
  }
}
