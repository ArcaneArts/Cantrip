import { useLayoutEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";

// Survive sidebar/project remounts, but start fresh with the app's query client
// on launch. Keep only IDs; refreshed summaries still supply all row content.
const sessionOrders = new WeakMap<
  QueryClient,
  Map<string, Map<string, number>>
>();

export function useConversationSessionOrder<T extends { id: string }>(
  projectId: string,
  rows: readonly T[],
): T[] {
  const client = useQueryClient();
  const identity = getClientSessionIdentitySnapshot();
  const scope = JSON.stringify([
    identity?.connectionId,
    identity?.accountId,
    identity?.serverId,
    identity?.serverUrl,
    identity?.userId,
    projectId,
  ]);
  let projects = sessionOrders.get(client);
  if (!projects) sessionOrders.set(client, (projects = new Map()));
  let order = projects.get(scope);
  if (!order) projects.set(scope, (order = new Map()));
  const ordered = [...rows].sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  useLayoutEffect(() => {
    // Capture the server's initial recency order only after it is displayed.
    // New/older paginated entries append; returning entries keep their place.
    for (const row of ordered)
      if (!order.has(row.id)) order.set(row.id, order.size);
  }, [order, ordered]);
  return ordered;
}
