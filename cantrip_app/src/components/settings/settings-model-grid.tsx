import {
  modelProfileOperation,
  type ModelOperation,
  type ModelProfileSummary,
  type ModelProviderSummary,
  type UserSettings,
} from "@cantrip/protocol";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  modelSearchText,
  useConfiguredModelSearch,
} from "@/components/chat/model-search";
import {
  formatAgentTime,
  formatConcurrency,
  formatTokenCount,
} from "@/components/projects/token-usage-analytics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListPageControls } from "@/components/ui/list-page-controls";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { modelOperationLabels } from "./model-operation-metadata";
import { providerRouteLabel } from "./provider-catalog-display";

const operations = ["language", "embedding", "decision"] as const;

function catalogSearchText(model: ModelProfileSummary) {
  return `${modelSearchText(model)} ${modelProfileOperation(model)}`;
}

export function SettingsModelGrid({
  title,
  models,
  providers,
  preferences,
  unavailableOperations,
  emptyMessage,
  details,
  removing,
  preferencesPending,
  onAdd,
  onEdit,
  onRemove,
  onDefault,
}: {
  title: string;
  models: readonly ModelProfileSummary[];
  providers: readonly ModelProviderSummary[];
  preferences: UserSettings;
  unavailableOperations: readonly ModelOperation[];
  emptyMessage: string;
  details: ReadonlyMap<string, string>;
  removing: boolean;
  preferencesPending: boolean;
  onAdd(operation: ModelOperation): void;
  onEdit(model: ModelProfileSummary): void;
  onRemove(model: ModelProfileSummary): void;
  onDefault(
    model: ModelProfileSummary,
    operation: "embedding" | "decision",
  ): void;
}) {
  const heading = useId();
  const section = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [requestedPage, setPage] = useState(0);
  const matches = useConfiguredModelSearch(models, query, catalogSearchText);
  const pageSize = 48;
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(matches.length / pageSize) - 1),
  );
  const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <section
      ref={section}
      aria-labelledby={heading}
      className="grid min-w-0 gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={heading} className="text-base font-semibold">
          {title}
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {models.length ? (
            <div className="relative min-w-40 flex-1 sm:w-60">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="h-8 pl-9"
                aria-label="Search models"
                placeholder="Search models…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </div>
          ) : null}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!providers.length}
              >
                <Plus className="size-3.5" /> Add model
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <StyledDropdownMenuContent align="end" sideOffset={4}>
                {operations.map((operation) => (
                  <StyledDropdownMenuItem
                    key={operation}
                    aria-label={`Add ${operation} model`}
                    disabled={unavailableOperations.includes(operation)}
                    onSelect={() => {
                      if (!unavailableOperations.includes(operation))
                        onAdd(operation);
                    }}
                  >
                    {modelOperationLabels[operation]} model
                  </StyledDropdownMenuItem>
                ))}
              </StyledDropdownMenuContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      {query && matches.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          {matches.length.toLocaleString()} of {models.length.toLocaleString()}{" "}
          models
        </p>
      ) : null}
      {visible.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3">
          {visible.map((model) => {
            const operation = modelProfileOperation(model);
            const defaultId =
              operation === "language"
                ? preferences.defaultModelId
                : operation === "embedding"
                  ? preferences.defaultEmbeddingModelId
                  : preferences.defaultDecisionModelId;
            const isDefault = defaultId === model.id;
            const routes = model.routes.filter(({ enabled }) => enabled);
            const hasTelemetry = Boolean(
              model.tokenUsage.totalTokens || model.agentTime.agentTimeMs,
            );
            const routeLabels = routes.map((route) => {
              const provider = providers.find(
                ({ id }) => id === route.providerId,
              );
              return provider
                ? providerRouteLabel(provider)
                : route.providerName;
            });
            return (
              <article
                key={model.id}
                className="relative flex min-w-0 flex-col gap-2 rounded-xl border bg-card/30 p-3.5 transition-colors hover:bg-card/65"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="min-w-0 flex-1">
                    <button
                      type="button"
                      aria-label={`Edit ${model.name}`}
                      title={`Edit ${model.name}`}
                      className="block max-w-full truncate text-left text-sm font-semibold outline-none before:absolute before:inset-0 before:cursor-pointer before:rounded-xl focus-visible:before:ring-2 focus-visible:before:ring-ring"
                      onClick={() => onEdit(model)}
                    >
                      {model.name}
                    </button>
                  </h3>
                  {isDefault ? (
                    <Badge variant="secondary">Default</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {modelOperationLabels[operation]}
                  {routes.length
                    ? ` · ${routes.length} enabled ${routes.length === 1 ? "route" : "routes"}`
                    : ""}
                </p>
                <p title={routeLabels.join(" → ")} className="truncate text-xs">
                  {routeLabels.join(" → ") || "No enabled routes"}
                </p>
                {details.get(model.id) ? (
                  <p className="text-xs text-muted-foreground">
                    {details.get(model.id)}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center gap-2 border-t pt-2">
                  {hasTelemetry ? (
                    <p className="min-w-0 text-[11px] text-muted-foreground tabular-nums">
                      {model.tokenUsage.totalTokens ? (
                        <span className="block">
                          {formatTokenCount(model.tokenUsage.totalTokens)}{" "}
                          tokens
                        </span>
                      ) : null}
                      {model.agentTime.agentTimeMs ? (
                        <span className="block">
                          {formatAgentTime(model.agentTime.agentTimeMs)} AI ·{" "}
                          {formatConcurrency(model.agentTime)}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  <div className="relative z-10 ml-auto flex shrink-0 items-center">
                    {operation !== "language" ? (
                      <Button
                        type="button"
                        className="size-7"
                        size="icon"
                        variant="ghost"
                        title={`Use as default ${operation} model`}
                        aria-label={`Use ${model.name} as default ${operation} model`}
                        disabled={preferencesPending || isDefault}
                        onClick={() => onDefault(model, operation)}
                      >
                        <Check className="size-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      className="size-7"
                      size="icon"
                      variant="ghost"
                      title={`Delete ${model.name}`}
                      aria-label={`Delete ${model.name}`}
                      disabled={removing}
                      onClick={() => onRemove(model)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">
          {query ? "No models match this search." : emptyMessage}
        </p>
      )}
      <ListPageControls
        count={matches.length}
        page={page}
        pageSize={pageSize}
        label="models"
        onPageChange={(nextPage) => {
          setPage(nextPage);
          section.current?.scrollIntoView({ block: "start" });
        }}
      />
    </section>
  );
}
