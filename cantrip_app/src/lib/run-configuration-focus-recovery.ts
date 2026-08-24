import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface RunConfigurationFocusRecoveryHost {
  document: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
}

export function runConfigurationRecoveryQueryKeys(
  projectId: string,
): QueryKey[] {
  return [
    ["run-configurations", projectId],
    ["run-configuration-runtimes", projectId],
    ["run-configuration-secrets", projectId],
    ["terminals", projectId],
  ];
}

export function installRunConfigurationFocusRecovery(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  projectId: string,
  host: RunConfigurationFocusRecoveryHost,
): () => void {
  let disposed = false;
  let scheduled = false;
  const scheduleRecovery = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      void Promise.allSettled(
        runConfigurationRecoveryQueryKeys(projectId).map((queryKey) =>
          queryClient.invalidateQueries({ exact: true, queryKey }),
        ),
      );
    });
  };
  const recoverWhenVisible = (): void => {
    if (host.document.visibilityState === "visible") scheduleRecovery();
  };

  host.window.addEventListener("focus", scheduleRecovery);
  host.document.addEventListener("visibilitychange", recoverWhenVisible);
  return () => {
    disposed = true;
    host.window.removeEventListener("focus", scheduleRecovery);
    host.document.removeEventListener("visibilitychange", recoverWhenVisible);
  };
}
