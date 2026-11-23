import {
  modelProfileOperation,
  type ModelOperation,
  type ModelProfileSummary,
  type ModelProviderSummary,
} from "@cantrip/protocol";
import { ModelCombobox } from "@/components/chat/model-combobox";
import {
  availableCatalogModelIds,
  catalogDisplayStatus,
  providerSupportsCatalog,
} from "./provider-catalog-display";
import { useProviderCatalog } from "./use-provider-catalog";

export function OperationDefaultPicker({
  operation,
  models,
  providers,
  workerId,
  value,
  pending,
  onChange,
}: {
  operation: Exclude<ModelOperation, "language">;
  models: ModelProfileSummary[];
  providers: ModelProviderSummary[];
  workerId: string | null;
  value: string | null;
  pending: boolean;
  onChange(value: string | null): void;
}) {
  const selected = models.find(
    (model) => model.id === value && modelProfileOperation(model) === operation,
  );
  const route = selected?.routes.find((route) => route.enabled);
  const provider = providers.find(
    (provider) => provider.id === route?.providerId,
  );
  const catalog = useProviderCatalog(
    provider?.id,
    workerId,
    Boolean(provider && providerSupportsCatalog(provider)),
    provider?.connectionRevision ?? provider?.updatedAt,
  );
  const entry = catalog.data?.models.find(
    (entry) => entry.nativeModelId === route?.modelName,
  );
  const status = provider
    ? catalogDisplayStatus(provider, catalog.data, workerId)
    : null;
  const available =
    entry && catalog.data
      ? availableCatalogModelIds(catalog.data, workerId).has(entry.id)
      : null;
  const note = !value
    ? null
    : !selected
      ? "Selected configuration is unavailable"
      : !route || !provider
        ? "No enabled provider route"
        : catalog.isError
          ? "Catalog unavailable · selection retained"
          : status === "stale" || status === "failed"
            ? "Catalog stale · selection retained"
            : available === false
              ? "Unavailable in selected scope · selection retained"
              : entry
                ? `${provider.name} · available in selected scope`
                : catalog.isLoading
                  ? "Loading availability…"
                  : `${provider.name} · availability unverified`;
  return (
    <div className="grid w-full gap-1 sm:w-72">
      <ModelCombobox
        ariaLabel={`Default ${operation} model`}
        models={models}
        operation={operation}
        value={value}
        disabled={pending}
        placeholder={
          value && !selected ? "Configuration unavailable" : "None selected"
        }
        noneLabel="None selected"
        onValueChange={(id) => onChange(id || null)}
        getOptionNote={(model) =>
          model.routes.some((route) => route.enabled)
            ? null
            : "No enabled route"
        }
      />
      {note ? (
        <span className="text-[11px] text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}
