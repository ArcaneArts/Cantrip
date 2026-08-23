import { Bot, ChevronRight, CircleCheck, CircleX, Loader2 } from "lucide-react";

import { activityLabel } from "./activity";
import type { AgentTurnParticipant } from "./agent-turn-projection";

function AgentStatusIcon({ agent }: { agent: AgentTurnParticipant }) {
  if (agent.active) {
    return <Loader2 className="size-3.5 animate-spin text-sky-500" />;
  }
  if (agent.status === "failed" || agent.status === "interrupted") {
    return <CircleX className="size-3.5 text-destructive" />;
  }
  return <CircleCheck className="size-3.5 text-emerald-500" />;
}

function compactText(value: string, length = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

export function SubagentLifecycleCard({
  agent,
  onOpen,
}: {
  agent: AgentTurnParticipant;
  onOpen(agentKey: string): void;
}) {
  const label =
    agent.scope.nickname ??
    agent.scope.agentPath.at(-1) ??
    `Agent ${agent.scope.agentThreadId.slice(0, 8)}`;
  const path = agent.scope.agentPath.join(" / ");
  const latestCommunication = agent.communications.at(-1);
  const latest = latestCommunication?.message?.trim()
    ? compactText(latestCommunication.message)
    : agent.latestActivity
      ? activityLabel(agent.latestActivity)
      : null;
  const indent = Math.min(agent.scope.depth - 1, 3) * 12;
  return (
    <button
      aria-label={`Open ${label} subagent transcript`}
      className="group flex w-full min-w-0 items-start gap-3 rounded-xl border bg-card/70 px-3 py-3 text-left transition-colors hover:bg-accent/50"
      data-agent-key={agent.key}
      data-slot="subagent-lifecycle-card"
      onClick={() => onOpen(agent.key)}
      style={{ marginLeft: indent, width: `calc(100% - ${indent}px)` }}
      type="button"
    >
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border bg-background">
        <Bot className="size-3.5 text-violet-500" />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {agent.scope.role ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {agent.scope.role}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] capitalize text-muted-foreground">
            <AgentStatusIcon agent={agent} />
            {agent.status}
          </span>
        </span>
        {path && path !== label ? (
          <span className="block truncate text-[10px] text-muted-foreground/70">
            {path}
          </span>
        ) : null}
        {agent.taskSummary ? (
          <span className="block text-xs leading-5 text-foreground/80">
            {compactText(agent.taskSummary)}
          </span>
        ) : null}
        {latest && latest !== agent.taskSummary ? (
          <span className="block truncate text-[11px] text-muted-foreground">
            {latest}
          </span>
        ) : null}
        {agent.communications.length > 0 ? (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {agent.communications.slice(-3).map((communication) => (
              <span
                className="rounded-full border px-1.5 py-0.5 text-[9px] capitalize text-muted-foreground"
                key={communication.id}
              >
                {communication.kind.replace(/([A-Z])/g, " $1")}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
