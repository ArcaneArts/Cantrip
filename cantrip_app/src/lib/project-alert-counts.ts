import { projectAlertCountsSchema } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { request } from "./api-client";
import { useAppLiveScope } from "./app-live-react";
export const projectAlertCountsKey = ["project-alert-counts"] as const;
export async function getProjectAlertCounts() {
  return projectAlertCountsSchema.parse(
    await request("/api/project-alerts/counts"),
  );
}
/** One owner aggregate; never opens a project, Chat, transcript or worker. */
export function useProjectAlertCounts(): ReadonlyMap<string, number> {
  useAppLiveScope({ kind: "current-user" });
  const counts = useQuery({
    queryKey: projectAlertCountsKey,
    queryFn: getProjectAlertCounts,
    staleTime: 5000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: 1,
  });
  return useMemo(
    () =>
      new Map(
        (counts.data ?? []).map(({ projectId, count }) => [projectId, count]),
      ),
    [counts.data],
  );
}
