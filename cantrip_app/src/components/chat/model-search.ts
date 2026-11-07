import type { ModelProfileSummary } from "@cantrip/protocol";
import { defaultFilter } from "cmdk";
import { useMemo } from "react";

export function modelSearchText(model: ModelProfileSummary): string {
  return [
    model.id,
    model.name,
    model.canonicalModelId,
    ...model.routes.flatMap((route) => [route.providerName, route.modelName]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterConfiguredModels(
  models: ModelProfileSummary[],
  query: string,
): ModelProfileSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? models.filter((model) => modelSearchText(model).includes(normalizedQuery))
    : models;
}

/** Rank the complete catalog before paging; unmounted models remain searchable.
 * Use cmdk's existing scoring so bounded menus retain their fuzzy matching. */
export function useConfiguredModelSearch(
  models: readonly ModelProfileSummary[],
  query: string,
) {
  const index = useMemo(
    () => models.map((model) => ({ model, text: modelSearchText(model) })),
    [models],
  );
  return useMemo(() => {
    if (!query) return models;
    const matches: {
      model: ModelProfileSummary;
      position: number;
      score: number;
    }[] = [];
    for (let position = 0; position < index.length; position++) {
      const entry = index[position]!;
      const score = defaultFilter(entry.text, query);
      if (score > 0) matches.push({ model: entry.model, position, score });
    }
    return matches
      .sort(
        (left, right) =>
          right.score - left.score || left.position - right.position,
      )
      .map((entry) => entry.model);
  }, [index, models, query]);
}
