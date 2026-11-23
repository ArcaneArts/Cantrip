import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { modelProfileOperation } from "@cantrip/protocol";
import { getSettings } from "@/lib/api";

/** Native inventories also serve explicit runtime resolution. Filter only their
 * presentation using the normal settings cache, never the execution inventory. */
export function useNonLanguageRoutes(enabled = true): ReadonlySet<string> {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled,
  });
  return useMemo(
    () =>
      new Set(
        (settings.data?.models ?? []).flatMap((model) =>
          model.routes
            .filter(
              (route) =>
                modelProfileOperation(model) !== "language" ||
                route.languageSelectionConflict,
            )
            .map((route) => route.id),
        ),
      ),
    [settings.data?.models],
  );
}
