import {
  nativeModelInventorySchema,
  type NativeModelInventory,
  type NativeModelInventoryRequest,
  type ProviderModelAvailability,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import { isAccountProviderKind } from "./account-provider.js";
import {
  accountProviderSupportsModel,
  evaluateModelRouteAvailability,
} from "./model-route-availability.js";

export type NativeModelInventoryRepository = Pick<
  ServerRepository,
  | "getModelProvider"
  | "listModelProviderAccounts"
  | "getModelRuntimes"
  | "getProviderModelCatalog"
>;

/** The same configured routes/discovery scopes used by Cantrip's model picker.
 * This is inventory, never an execution grant or a provider-account migration. */
export async function readNativeModelInventory(
  repository: NativeModelInventoryRepository,
  ownerId: string,
  request: NativeModelInventoryRequest,
): Promise<NativeModelInventory | null> {
  const provider = await repository.getModelProvider(
    ownerId,
    request.providerId,
  );
  if (!provider) return null;
  const accountProvider = isAccountProviderKind(provider.kind);
  if (accountProvider) {
    const accounts = await repository.listModelProviderAccounts(
      ownerId,
      request.providerId,
    );
    if (
      !request.providerAccountId ||
      !accounts?.some(
        (account) =>
          account.id === request.providerAccountId && account.enabled,
      )
    )
      return null;
  } else if (request.providerAccountId !== null) return null;

  const [runtimes, catalog] = await Promise.all([
    repository.getModelRuntimes(
      ownerId,
      undefined,
      undefined,
      false,
      request.providerId,
    ),
    repository.getProviderModelCatalog(ownerId, request.providerId),
  ]);
  const availability = new Map<string, ProviderModelAvailability[]>();
  for (const entry of catalog?.availability ?? []) {
    const group = availability.get(entry.providerModelId) ?? [];
    group.push(entry);
    availability.set(entry.providerModelId, group);
  }
  const models = runtimes
    .filter((runtime) => {
      if (runtime.provider.id !== request.providerId) return false;
      const states = runtime.model.providerModelId
        ? (availability.get(runtime.model.providerModelId) ?? [])
        : [];
      if (!accountProvider)
        return evaluateModelRouteAvailability(runtime, states, request.workerId)
          .available;
      const scoped = states.filter(
        (entry) =>
          entry.providerAccountId === request.providerAccountId &&
          (entry.workerId === null || entry.workerId === request.workerId),
      );
      // Match canonical account routing: server-wide observations take priority.
      const observed =
        scoped.find((entry) => entry.workerId === null) ?? scoped[0];
      return accountProviderSupportsModel(
        runtime.model.providerModelId,
        observed?.state ?? null,
      );
    })
    .map((runtime) => runtime.model)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id) ||
        left.routeId.localeCompare(right.routeId),
    );
  // Parse only public model metadata. Credentials and other account information
  // returned by the repository never enter this response.
  return nativeModelInventorySchema.parse({
    ...request,
    providerKind: provider.kind,
    models,
  });
}
