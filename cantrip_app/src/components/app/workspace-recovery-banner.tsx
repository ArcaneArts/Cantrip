import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import type { useWorkspaceConnection } from "./use-workspace-connection";
import { WorkspaceReconnectBanner } from "./workspace-reconnect-banner";

type Connection = ReturnType<typeof useWorkspaceConnection>;
export function WorkspaceRecoveryBanner({
  workspace,
  migration,
  transferPending = false,
}: {
  transferPending?: boolean;
  migration?: { error: unknown; retry(): void };
  workspace: Pick<
    Connection,
    "loading" | "error" | "retry" | "refresh" | "retryCommand" | "retryLabels"
  > & {
    controllerState: Pick<
      NonNullable<Connection["controllerState"]>,
      "disposed" | "error" | "refreshError"
    > | null;
    presentation: Pick<Connection["presentation"], "error">;
  };
}) {
  const state = workspace.controllerState;
  const connectionUnavailable = Boolean(workspace.error || state?.disposed);
  const issue = connectionUnavailable
    ? {
        title: "Workspace connection unavailable",
        error: workspace.error ?? state?.error,
        action: "Reconnect",
        retry: workspace.retry,
      }
    : state?.error
      ? {
          title: "Workspace action could not be confirmed",
          error: state.error,
          action: "Retry action",
          retry: workspace.retryCommand,
        }
      : state?.refreshError
        ? {
            title: "Workspace updates unavailable",
            error: state.refreshError,
            action: "Refresh",
            retry: workspace.refresh,
          }
        : workspace.presentation.error
          ? {
              title: "Workspace labels unavailable",
              error: workspace.presentation.error,
              action: "Retry labels",
              retry: workspace.retryLabels,
            }
          : migration?.error
            ? {
                title: "File tab migration needs attention",
                error: migration.error,
                action: "Retry migration",
                retry: migration.retry,
              }
            : null;
  if (!issue)
    return workspace.loading || transferPending ? (
      <div
        role="status"
        className="shrink-0 px-3 py-2 text-sm text-muted-foreground"
      >
        {workspace.loading
          ? "Loading workspace…"
          : "Moving views into this window…"}
      </div>
    ) : null;
  if (connectionUnavailable)
    return <WorkspaceReconnectBanner error={issue.error} retry={issue.retry} />;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-warning/30 px-3 py-2 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p>{issue.title}</p>
        {issue.error ? (
          <p className="break-words text-xs text-muted-foreground">
            {errorMessage(issue.error)}
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" onClick={issue.retry}>
        {issue.action}
      </Button>
    </div>
  );
}
