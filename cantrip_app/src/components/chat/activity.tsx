import type { AgentActivity } from "@cantrip/protocol";
import {
  Check,
  ChevronRight,
  CircleX,
  FileDiff,
  Loader2,
  Terminal,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function ActivityState({ activity }: { activity: AgentActivity }) {
  if (activity.status === "running") {
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  }
  if (activity.status === "completed") {
    return <Check className="size-3.5 text-emerald-600" />;
  }
  return <CircleX className="size-3.5 text-destructive" />;
}

function changeLabel(kind: "add" | "delete" | "update") {
  if (kind === "add") return "Added";
  if (kind === "delete") return "Deleted";
  return "Updated";
}

export function Activity({ activity }: { activity: AgentActivity }) {
  if (activity.type === "fileChange") {
    return (
      <div className="min-w-0 border-l-2 border-border py-1 pl-4 text-sm">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {activity.status === "running"
              ? "Changing files"
              : `Changed ${activity.changes.length} ${activity.changes.length === 1 ? "file" : "files"}`}
          </span>
          <ActivityState activity={activity} />
        </div>
        {activity.changes.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {activity.changes.map((change) => (
              <li
                key={`${change.kind}:${change.path}`}
                className="flex min-w-0 items-center gap-2 text-xs"
              >
                <Badge
                  variant="secondary"
                  className={cn(
                    "h-5 shrink-0 px-1.5 text-[10px] font-normal",
                    change.kind === "delete" && "text-destructive",
                  )}
                >
                  {changeLabel(change.kind)}
                </Badge>
                <code className="min-w-0 break-all font-mono text-muted-foreground">
                  {change.path}
                </code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const hasDetails = Boolean(activity.output || activity.cwd);
  return (
    <details
      className="group min-w-0 border-l-2 border-border py-1 pl-4 text-sm"
      open={activity.status === "failed" ? true : undefined}
    >
      <summary
        className={cn(
          "flex min-w-0 list-none items-center gap-2",
          hasDetails && "cursor-pointer",
        )}
      >
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {activity.status === "running" ? "Running" : "Ran"}
        </span>
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {activity.command}
        </code>
        <ActivityState activity={activity} />
        {hasDetails ? (
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        ) : null}
      </summary>
      {hasDetails ? (
        <div className="mt-2 min-w-0 space-y-2 pl-6">
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {activity.cwd}
          </p>
          {activity.output ? (
            <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 font-mono text-xs leading-5">
              {activity.output}
            </pre>
          ) : null}
          {activity.exitCode !== null ? (
            <p className="text-[11px] text-muted-foreground">
              Exit code {activity.exitCode}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
