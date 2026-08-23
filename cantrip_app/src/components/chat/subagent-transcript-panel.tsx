import { Bot, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";

import { Activity, activityLabel } from "./activity";
import type {
  AgentTurnParticipant,
  AgentTurnProjection,
} from "./agent-turn-projection";
import { Markdown } from "./markdown";

function agentLabel(agent: AgentTurnParticipant): string {
  return (
    agent.scope.nickname ??
    agent.scope.agentPath.at(-1) ??
    `Agent ${agent.scope.agentThreadId.slice(0, 8)}`
  );
}

function sameRootTurnAgents(
  projection: AgentTurnProjection,
  selected: AgentTurnParticipant,
): AgentTurnParticipant[] {
  return projection.agents.filter(
    (agent) => agent.scope.rootTurnId === selected.scope.rootTurnId,
  );
}

function ancestorAgents(
  agents: readonly AgentTurnParticipant[],
  selected: AgentTurnParticipant,
): AgentTurnParticipant[] {
  const byThreadId = new Map(
    agents.map((agent) => [agent.scope.agentThreadId, agent]),
  );
  const ancestors: AgentTurnParticipant[] = [];
  let parentThreadId = selected.scope.parentThreadId;
  const visited = new Set<string>();
  while (parentThreadId && !visited.has(parentThreadId)) {
    visited.add(parentThreadId);
    const parent = byThreadId.get(parentThreadId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentThreadId = parent.scope.parentThreadId;
  }
  return ancestors;
}

function escapedSelector(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function participantModelSummary(
  participant: AgentTurnParticipant,
  fallback: string,
): string {
  const context = participant.stream.find(
    (item) =>
      item.type === "activity" && item.activity.type === "instructionContext",
  );
  if (
    context?.type !== "activity" ||
    context.activity.type !== "instructionContext"
  ) {
    return fallback;
  }
  return [context.activity.model, context.activity.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
}

export function SubagentTranscriptPanel({
  focusItemKey,
  modelSummary,
  onOpenFile,
  onSelectAgent,
  projection,
  selectedAgentKey,
}: {
  focusItemKey: string | null;
  modelSummary: string;
  onOpenFile(path: string): void;
  onSelectAgent(agentKey: string, focusItemKey?: string | null): void;
  projection: AgentTurnProjection;
  selectedAgentKey: string;
}) {
  const selected = projection.byKey.get(selectedAgentKey) ?? null;
  const streamRef = useRef<HTMLDivElement>(null);
  const agents = useMemo(
    () => (selected ? sameRootTurnAgents(projection, selected) : []),
    [projection, selected],
  );
  useEffect(() => {
    if (!focusItemKey) return;
    const element = streamRef.current?.querySelector<HTMLElement>(
      `[data-subagent-item-key="${escapedSelector(focusItemKey)}"]`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusItemKey, selectedAgentKey]);

  if (!selected) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        This subagent is no longer available in the loaded message history.
      </div>
    );
  }

  const ancestors = ancestorAgents(agents, selected);
  const effectiveModelSummary = participantModelSummary(selected, modelSummary);
  return (
    <div
      className="flex h-full min-h-0 flex-col pt-11"
      data-slot="subagent-transcript-panel"
    >
      <div className="shrink-0 space-y-3 border-b px-3 pb-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border bg-card">
            <Bot className="size-3.5 text-violet-500" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">
                {agentLabel(selected)}
              </h3>
              <span className="ml-auto shrink-0 text-[10px] capitalize text-muted-foreground">
                {selected.status}
              </span>
            </div>
            <p className="truncate text-[10px] text-muted-foreground">
              {[selected.scope.role, effectiveModelSummary]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <nav
          aria-label="Subagent breadcrumb"
          className="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-muted-foreground"
        >
          <span className="shrink-0">Root</span>
          {ancestors.map((ancestor) => (
            <span className="contents" key={ancestor.key}>
              <ChevronRight className="size-3 shrink-0" />
              <button
                className="truncate hover:text-foreground"
                onClick={() => onSelectAgent(ancestor.key)}
                type="button"
              >
                {agentLabel(ancestor)}
              </button>
            </span>
          ))}
          <ChevronRight className="size-3 shrink-0" />
          <span className="truncate text-foreground">
            {agentLabel(selected)}
          </span>
        </nav>
        <div
          aria-label="Agents in this turn"
          className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border bg-muted/20 p-1"
        >
          {agents.map((agent) => (
            <button
              aria-current={agent.key === selected.key ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                agent.key === selected.key &&
                  "bg-accent text-accent-foreground",
              )}
              key={agent.key}
              onClick={() => onSelectAgent(agent.key)}
              style={{
                paddingLeft: 8 + Math.min(agent.scope.depth - 1, 5) * 12,
              }}
              type="button"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  agent.active
                    ? "bg-sky-500"
                    : agent.status === "failed" ||
                        agent.status === "interrupted"
                      ? "bg-destructive"
                      : "bg-emerald-500",
                )}
              />
              <span className="truncate">{agentLabel(agent)}</span>
              <span className="ml-auto shrink-0 text-[9px] capitalize text-muted-foreground">
                {agent.status}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-3">
          {selected.stream.map((item) => (
            <div
              className={cn(
                "min-w-0",
                item.type === "text" &&
                  item.phase === "commentary" &&
                  "text-muted-foreground",
              )}
              data-subagent-item-key={item.key}
              key={item.key}
            >
              {item.type === "text" ? (
                <Markdown onOpenFile={onOpenFile}>{item.text}</Markdown>
              ) : (
                <Activity activity={item.activity} />
              )}
            </div>
          ))}
          {selected.stream.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recoverable activity was recorded for this agent.
            </p>
          ) : null}
        </div>
      </div>
      <span className="sr-only">
        Read-only subagent stream. Latest activity{" "}
        {selected.latestActivity
          ? activityLabel(selected.latestActivity)
          : "unavailable"}
        .
      </span>
    </div>
  );
}
