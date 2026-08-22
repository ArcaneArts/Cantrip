import type { AgentActivity } from "@cantrip/protocol";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  CircleX,
  Clock3,
  Combine,
  Eye,
  FileDiff,
  GitBranch,
  Image,
  ListChecks,
  Loader2,
  MessageSquareWarning,
  Network,
  Search,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { displayCommand } from "./command-display";
import { Markdown } from "./markdown";
import { formatElapsedTime } from "./timeline";

function isCodeGraphActivity(activity: AgentActivity) {
  return (
    activity.type === "mcpToolCall" &&
    activity.server.toLowerCase() === "codegraph"
  );
}

function codeGraphQuery(activity: AgentActivity) {
  if (activity.type !== "mcpToolCall" || !activity.query) return null;
  const query = activity.query.replace(/\s+/g, " ").trim();
  if (!query) return null;
  return query.length > 110 ? `${query.slice(0, 109).trimEnd()}…` : query;
}

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

function formatDuration(durationMs: number | null | undefined) {
  if (durationMs === null || durationMs === undefined) return null;
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function formatReset(resetsAt: number | null) {
  if (resetsAt === null) return null;
  return new Date(resetsAt * 1_000).toLocaleString();
}

function CorrelationDetails({ activity }: { activity: AgentActivity }) {
  const correlation = activity.correlation;
  if (!correlation) return null;
  const identifiers = [
    correlation.threadId && `thread ${correlation.threadId}`,
    correlation.turnId && `turn ${correlation.turnId}`,
    correlation.itemId && `item ${correlation.itemId}`,
    correlation.diagnosticId && `diagnostic ${correlation.diagnosticId}`,
  ].filter(Boolean);
  return (
    <details className="text-[10px] text-muted-foreground">
      <summary className="cursor-pointer select-none">Runtime source</summary>
      <div className="mt-1 break-all font-mono leading-4">
        <p>{correlation.sourceMethod}</p>
        {identifiers.map((identifier) => (
          <p key={identifier}>{identifier}</p>
        ))}
      </div>
    </details>
  );
}

function RichActivityIcon({ activity }: { activity: AgentActivity }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (activity.type) {
    case "instructionContext":
      return <ShieldCheck className={className} />;
    case "plan":
      return <ListChecks className={className} />;
    case "reasoning":
      return <BrainCircuit className={className} />;
    case "mcpToolCall":
      return isCodeGraphActivity(activity) ? (
        <Workflow className="size-4 shrink-0 text-cyan-500" />
      ) : (
        <Network className={className} />
      );
    case "dynamicToolCall":
      return <Combine className={className} />;
    case "collabToolCall":
    case "subAgent":
      return <Bot className={className} />;
    case "webSearch":
      return <Search className={className} />;
    case "imageView":
      return <Image className={className} />;
    case "reviewMode":
      return <ShieldCheck className={className} />;
    case "contextCompaction":
      return <Combine className={className} />;
    case "notice":
      return activity.level === "error" ? (
        <MessageSquareWarning className="size-4 shrink-0 text-destructive" />
      ) : (
        <AlertTriangle className="size-4 shrink-0 text-amber-500" />
      );
    case "usage":
    case "rateLimit":
      return <CircleGauge className={className} />;
    case "turnSummary":
      return <Clock3 className={className} />;
    default:
      return <Eye className={className} />;
  }
}

export function activityLabel(activity: AgentActivity): string {
  switch (activity.type) {
    case "instructionContext":
      return `Effective instructions · ${activity.provenance === "exact" ? "Exact" : activity.provenance === "assembled" ? "Assembled" : "Unavailable"}`;
    case "plan":
      return activity.status === "running" ? "Updating plan" : "Updated plan";
    case "reasoning":
      return activity.status === "running" ? "Reasoning" : "Reasoned";
    case "mcpToolCall":
      if (isCodeGraphActivity(activity)) {
        const query = codeGraphQuery(activity);
        return `CodeGraph${query ? ` · ${query}` : ""}`;
      }
      return `MCP · ${activity.server}/${activity.tool}`;
    case "dynamicToolCall":
      return `Tool · ${activity.namespace ? `${activity.namespace}/` : ""}${activity.tool}`;
    case "collabToolCall":
      return `Collaboration · ${activity.tool}`;
    case "subAgent":
      return `Subagent · ${activity.agentPath}`;
    case "webSearch":
      return activity.query ? `Searched · ${activity.query}` : "Web search";
    case "imageView":
      return `Viewed image · ${activity.path}`;
    case "reviewMode":
      return `${activity.state === "entered" ? "Entered" : "Exited"} review mode`;
    case "contextCompaction":
      return activity.status === "running"
        ? "Compacting context"
        : "Compacted context";
    case "notice":
      return activity.message;
    case "usage":
      return `Used ${activity.last.totalTokens.toLocaleString()} tokens`;
    case "rateLimit":
      return activity.primary
        ? `Rate limit · ${activity.primary.usedPercent.toFixed(0)}% used`
        : "Rate limit updated";
    case "turnSummary": {
      const duration = formatDuration(activity.durationMs);
      return `Turn ${activity.status}${duration ? ` in ${duration}` : ""}`;
    }
    case "worktree":
      return activity.summary;
    case "fileChange":
      return activity.status === "running"
        ? "Changing files"
        : `Changed ${activity.changes.length} ${activity.changes.length === 1 ? "file" : "files"}`;
    case "command":
      return displayCommand(activity.command);
  }
}

function RichActivityDetails({ activity }: { activity: AgentActivity }) {
  switch (activity.type) {
    case "instructionContext":
      return (
        <div className="space-y-1">
          <p>Provenance: {activity.provenance}</p>
          {activity.sources.map((source) => (
            <p key={source}>{source}</p>
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="space-y-2">
          {activity.explanation ? <p>{activity.explanation}</p> : null}
          {activity.text ? (
            <p className="whitespace-pre-wrap">{activity.text}</p>
          ) : null}
          {activity.steps.length > 0 ? (
            <ul className="space-y-1">
              {activity.steps.map((step, index) => (
                <li key={`${index}:${step.step}`} className="flex gap-2">
                  <span aria-hidden="true">
                    {step.status === "completed"
                      ? "✓"
                      : step.status === "inProgress"
                        ? "→"
                        : "·"}
                  </span>
                  <span>{step.step}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "reasoning":
      return activity.summary.length > 0 ? (
        <div className="space-y-2">
          {activity.summary.map((part, index) => (
            <p
              key={`${index}:${part.slice(0, 24)}`}
              className="whitespace-pre-wrap"
            >
              {part}
            </p>
          ))}
        </div>
      ) : null;
    case "mcpToolCall":
      if (isCodeGraphActivity(activity)) {
        return (
          <div className="space-y-2">
            {activity.error ? (
              <p className="text-destructive">{activity.error}</p>
            ) : null}
            {activity.resultText ? (
              <div className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 text-foreground">
                <Markdown>{activity.resultText}</Markdown>
              </div>
            ) : activity.status === "running" ? (
              <p>Exploring the project graph…</p>
            ) : (
              <p>No result details were returned.</p>
            )}
            {formatDuration(activity.durationMs) ? (
              <p>Duration {formatDuration(activity.durationMs)}</p>
            ) : null}
          </div>
        );
      }
      return (
        <div className="space-y-1">
          {activity.error ? (
            <p className="text-destructive">{activity.error}</p>
          ) : null}
          {formatDuration(activity.durationMs) ? (
            <p>Duration {formatDuration(activity.durationMs)}</p>
          ) : null}
        </div>
      );
    case "dynamicToolCall":
      return formatDuration(activity.durationMs) ||
        activity.success !== null ? (
        <p>
          {activity.success === null
            ? ""
            : activity.success
              ? "Succeeded"
              : "Failed"}
          {formatDuration(activity.durationMs)
            ? `${activity.success === null ? "" : " · "}${formatDuration(activity.durationMs)}`
            : ""}
        </p>
      ) : null;
    case "collabToolCall":
      return (
        <div className="space-y-2">
          {activity.prompt ? (
            <p className="whitespace-pre-wrap">{activity.prompt}</p>
          ) : null}
          {activity.receiverThreadIds.length > 0 ? (
            <p className="break-all font-mono text-[11px]">
              Targets: {activity.receiverThreadIds.join(", ")}
            </p>
          ) : null}
          {activity.agentStates.map((agent) => (
            <p key={agent.threadId}>
              {agent.threadId}: {agent.status}
              {agent.message ? ` · ${agent.message}` : ""}
            </p>
          ))}
        </div>
      );
    case "subAgent":
      return <p className="break-all font-mono">{activity.agentThreadId}</p>;
    case "webSearch":
      return activity.action ? <p>{activity.action}</p> : null;
    case "imageView":
      return <p className="break-all font-mono">{activity.path}</p>;
    case "reviewMode":
      return activity.review ? (
        <p className="whitespace-pre-wrap">{activity.review}</p>
      ) : null;
    case "notice":
      return (
        <div className="space-y-1">
          {activity.details ? (
            <p className="whitespace-pre-wrap">{activity.details}</p>
          ) : null}
          {activity.willRetry !== null ? (
            <p>
              {activity.willRetry
                ? "Codex will retry."
                : "Codex will not retry."}
            </p>
          ) : null}
        </div>
      );
    case "usage":
      return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
          <span>Input</span>
          <span>{activity.last.inputTokens.toLocaleString()}</span>
          <span>Cached input</span>
          <span>{activity.last.cachedInputTokens.toLocaleString()}</span>
          <span>Output</span>
          <span>{activity.last.outputTokens.toLocaleString()}</span>
          <span>Reasoning output</span>
          <span>{activity.last.reasoningOutputTokens.toLocaleString()}</span>
          {activity.contextUsedPercent !== null ? (
            <>
              <span>Context used</span>
              <span>{activity.contextUsedPercent.toFixed(1)}%</span>
            </>
          ) : null}
        </div>
      );
    case "rateLimit":
      return (
        <div className="space-y-1 tabular-nums">
          {activity.limitName ? <p>{activity.limitName}</p> : null}
          {activity.primary ? (
            <p>
              Primary: {activity.primary.usedPercent.toFixed(1)}% used
              {formatReset(activity.primary.resetsAt)
                ? ` · resets ${formatReset(activity.primary.resetsAt)}`
                : ""}
            </p>
          ) : null}
          {activity.secondary ? (
            <p>
              Secondary: {activity.secondary.usedPercent.toFixed(1)}% used
              {formatReset(activity.secondary.resetsAt)
                ? ` · resets ${formatReset(activity.secondary.resetsAt)}`
                : ""}
            </p>
          ) : null}
          {activity.reachedType ? (
            <p className="text-destructive">
              {activity.reachedType.replaceAll("_", " ")}
            </p>
          ) : null}
        </div>
      );
    case "turnSummary":
      return activity.startedAt !== null && activity.completedAt !== null ? (
        <p>
          {new Date(activity.startedAt * 1_000).toLocaleString()} –{" "}
          {new Date(activity.completedAt * 1_000).toLocaleString()}
        </p>
      ) : null;
    case "contextCompaction":
    case "worktree":
    case "fileChange":
    case "command":
      return null;
  }
}

export function Activity({ activity }: { activity: AgentActivity }) {
  if (activity.type === "instructionContext") return null;
  if (activity.type === "reasoning") {
    return activity.summary.length > 0 ? (
      <div className="min-w-0 space-y-2 py-1 text-xs leading-5 text-muted-foreground">
        {activity.summary.map((part, index) => (
          <p
            key={`${index}:${part.slice(0, 24)}`}
            className="whitespace-pre-wrap"
          >
            {part}
          </p>
        ))}
      </div>
    ) : null;
  }
  if (activity.type === "worktree") {
    return (
      <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
        <GitBranch className="size-4 shrink-0 text-violet-500" />
        <span className="min-w-0 truncate">{activity.summary}</span>
        <ActivityState activity={activity} />
        <CorrelationDetails activity={activity} />
      </div>
    );
  }
  if (activity.type === "fileChange") {
    return (
      <div className="min-w-0 py-1 text-sm">
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
        <div className="mt-1 pl-6">
          <CorrelationDetails activity={activity} />
        </div>
      </div>
    );
  }

  if (activity.type !== "command") {
    const details = <RichActivityDetails activity={activity} />;
    const showCorrelation =
      Boolean(activity.correlation) && !isCodeGraphActivity(activity);
    const hasDetails =
      activity.type === "plan"
        ? Boolean(
            activity.text || activity.explanation || activity.steps.length,
          )
        : activity.type === "mcpToolCall"
          ? Boolean(
              activity.error ||
              activity.resultText ||
              activity.durationMs !== null,
            )
          : activity.type === "dynamicToolCall"
            ? activity.success !== null || activity.durationMs !== null
            : activity.type === "collabToolCall"
              ? Boolean(
                  activity.prompt ||
                  activity.receiverThreadIds.length ||
                  activity.agentStates.length,
                )
              : activity.type === "webSearch"
                ? Boolean(activity.action)
                : activity.type === "reviewMode"
                  ? Boolean(activity.review)
                  : activity.type === "notice"
                    ? Boolean(activity.details || activity.willRetry !== null)
                    : activity.type === "contextCompaction"
                      ? false
                      : true;
    return (
      <details
        className="group min-w-0 py-1 text-sm"
        open={activity.type === "notice" && activity.level === "error"}
      >
        <summary
          className={cn(
            "flex min-w-0 list-none items-center gap-2",
            (hasDetails || showCorrelation) && "cursor-pointer",
          )}
        >
          <RichActivityIcon activity={activity} />
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              activity.type === "notice" &&
                activity.level === "error" &&
                "text-destructive",
            )}
          >
            {activityLabel(activity)}
          </span>
          <ActivityState activity={activity} />
          {hasDetails || showCorrelation ? (
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          ) : null}
        </summary>
        {hasDetails || showCorrelation ? (
          <div className="mt-2 min-w-0 space-y-2 pl-6 text-xs leading-5 text-muted-foreground">
            {details}
            {showCorrelation ? (
              <CorrelationDetails activity={activity} />
            ) : null}
          </div>
        ) : null}
      </details>
    );
  }

  const hasDetails = Boolean(
    activity.output ||
    activity.cwd ||
    activity.durationMs !== null ||
    activity.correlation,
  );
  return (
    <details
      className="group min-w-0 py-1 text-sm"
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
          {displayCommand(activity.command)}
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
          {formatDuration(activity.durationMs) ? (
            <p className="text-[11px] text-muted-foreground">
              Duration {formatDuration(activity.durationMs)}
            </p>
          ) : null}
          <CorrelationDetails activity={activity} />
        </div>
      ) : null}
    </details>
  );
}

export function ActivityGroup({
  children,
  endedAt,
  onViewTrajectory,
  startedAt,
  turnId,
  turnKey,
}: {
  children: ReactNode;
  endedAt: string | null;
  onViewTrajectory?(turnKey: string): void;
  startedAt: string;
  turnId: string | null;
  turnKey: string;
}) {
  const completed = endedAt !== null;
  const [open, setOpen] = useState(!completed);

  useEffect(() => {
    setOpen(!completed);
  }, [completed]);

  if (!completed) {
    return (
      <div
        className="grid min-w-0 gap-0"
        data-turn-id={turnId ?? undefined}
        data-turn-key={turnKey}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className="min-w-0"
      data-turn-id={turnId ?? undefined}
      data-turn-key={turnKey}
    >
      <div className="flex items-center border-b">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span>Worked for {formatElapsedTime(startedAt, endedAt)}</span>
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
        {onViewTrajectory ? (
          <button
            aria-label="View turn trajectory"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onViewTrajectory(turnKey)}
            title="View turn trajectory"
            type="button"
          >
            <Network className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? <div className="grid min-w-0 gap-0 py-1">{children}</div> : null}
    </div>
  );
}
