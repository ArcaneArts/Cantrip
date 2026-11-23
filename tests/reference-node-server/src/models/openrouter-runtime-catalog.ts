import type { ModelRuntime } from "../db/repository.js";
import { isOpenRouterProvider } from "./openrouter-catalog.js";

type CatalogLoader = (providerId: string) => Promise<boolean>;

/**
 * Hydrates OpenRouter metadata once per server process before a model route is
 * used. The settings screen is no longer responsible for making reasoning and
 * capability metadata available to chat execution.
 */
export class OpenRouterRuntimeCatalogHydrator {
  readonly #hydrated = new Set<string>();
  readonly #inFlight = new Map<string, Promise<boolean>>();
  readonly #load: CatalogLoader;

  constructor(load: CatalogLoader) {
    this.#load = load;
  }

  invalidate(providerId: string): void {
    this.#hydrated.delete(providerId);
  }

  markHydrated(providerId: string): void {
    this.#hydrated.add(providerId);
  }

  async hydrate(runtimes: ModelRuntime[]): Promise<boolean> {
    const providerIds = [
      ...new Set(
        runtimes
          .filter((runtime) => isOpenRouterProvider(runtime.provider))
          .map((runtime) => runtime.provider.id),
      ),
    ].filter((providerId) => !this.#hydrated.has(providerId));
    if (providerIds.length === 0) return false;

    const loaded = await Promise.all(
      providerIds.map((providerId) => this.#hydrateProvider(providerId)),
    );
    return loaded.some(Boolean);
  }

  #hydrateProvider(providerId: string): Promise<boolean> {
    const active = this.#inFlight.get(providerId);
    if (active) return active;

    const hydration = this.#load(providerId)
      .then((loaded) => {
        if (loaded) this.#hydrated.add(providerId);
        return loaded;
      })
      .finally(() => {
        if (this.#inFlight.get(providerId) === hydration) {
          this.#inFlight.delete(providerId);
        }
      });
    this.#inFlight.set(providerId, hydration);
    return hydration;
  }
}
