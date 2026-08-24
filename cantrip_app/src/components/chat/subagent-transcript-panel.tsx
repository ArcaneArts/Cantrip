import { Bot, ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";

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

interface SubagentTranscriptPanelProps {
  focusItemKey: string | null;
  modelSummary: string;
  onOpenFile(path: string): void;
  onSelectAgent(agentKey: string, focusItemKey?: string | null): void;
  onSelectRoot(rootTurnId: string): void;
  projection: AgentTurnProjection;
  rootTurnId: string | null;
  selectedAgentKey: string | null;
}

function sameParticipantSnapshot(
  previous: AgentTurnParticipant,
  next: AgentTurnParticipant,
): boolean {
  return (
    previous.key === next.key &&
    previous.status === next.status &&
    previous.active === next.active &&
    previous.lastSequence === next.lastSequence &&
    previous.lastActiveAtMs === next.lastActiveAtMs &&
    previous.stream.length === next.stream.length &&
    previous.scope.nickname === next.scope.nickname &&
    previous.scope.role === next.scope.role &&
    previous.scope.agentPath.join("\u001f") ===
      next.scope.agentPath.join("\u001f")
  );
}

function equivalentFinishedPanel(
  previous: SubagentTranscriptPanelProps,
  next: SubagentTranscriptPanelProps,
): boolean {
  if (
    previous.focusItemKey !== next.focusItemKey ||
    previous.modelSummary !== next.modelSummary ||
    previous.rootTurnId !== next.rootTurnId ||
    previous.selectedAgentKey !== next.selectedAgentKey
  ) {
    return false;
  }
  const previousAgents = previous.selectedAgentKey
    ? [previous.projection.byKey.get(previous.selectedAgentKey)].filter(
        (agent): agent is AgentTurnParticipant => Boolean(agent),
      )
    : previous.projection.agents.filter(
        (agent) => agent.scope.rootTurnId === previous.rootTurnId,
      );
  const nextAgents = next.selectedAgentKey
    ? [next.projection.byKey.get(next.selectedAgentKey)].filter(
        (agent): agent is AgentTurnParticipant => Boolean(agent),
      )
    : next.projection.agents.filter(
        (agent) => agent.scope.rootTurnId === next.rootTurnId,
      );
  if (
    previousAgents.length !== nextAgents.length ||
    previousAgents.some((agent) => agent.active) ||
    nextAgents.some((agent) => agent.active)
  ) {
    return false;
  }
  return previousAgents.every((agent, index) => {
    const nextAgent = nextAgents[index];
    return Boolean(nextAgent && sameParticipantSnapshot(agent, nextAgent));
  });
}

function SubagentTranscriptPanelComponent({
  focusItemKey,
  modelSummary,
  onOpenFile,
  onSelectAgent,
  onSelectRoot,
  projection,
  rootTurnId,
  selectedAgentKey,
}: SubagentTranscriptPanelProps) {
  const selected = selectedAgentKey
    ? (projection.byKey.get(selectedAgentKey) ?? null)
    : null;
  const streamRef = useRef<HTMLDivElement>(null);
  const agents = useMemo(
    () =>
      selected
        ? sameRootTurnAgents(projection, selected)
        : projection.agents.filter(
            (agent) => agent.scope.rootTurnId === rootTurnId,
          ),
    [projection, rootTurnId, selected],
  );
  useEffect(() => {
    if (!focusItemKey) return;
    const element = streamRef.current?.querySelector<HTMLElement>(
      `[data-subagent-item-key="${escapedSelector(focusItemKey)}"]`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusItemKey, selectedAgentKey]);

  if (!selected && !rootTurnId) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        This subagent is no longer available in the loaded message history.
      </div>
    );
  }

  if (!selected) {
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
              <h3 className="truncate text-sm font-medium">Subagents</h3>
              <p className="truncate text-[10px] text-muted-foreground">
                {agents.length} {agents.length === 1 ? "agent" : "agents"} in
                this turn
              </p>
            </div>
          </div>
          <nav
            aria-label="Subagent breadcrumb"
            className="text-[11px] text-foreground"
          >
            Root
          </nav>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div
            aria-label="Agents in this turn"
            className="space-y-0.5 rounded-lg border bg-muted/20 p-1"
          >
            {agents.map((agent) => (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent"
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
            {agents.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No subagents were recorded for this turn.
              </p>
            ) : null}
          </div>
        </div>
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
          <button
            className="shrink-0 hover:text-foreground"
            onClick={() => onSelectRoot(selected.scope.rootTurnId)}
            type="button"
          >
            Root
          </button>
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

export const SubagentTranscriptPanel = memo(
  SubagentTranscriptPanelComponent,
  equivalentFinishedPanel,
);
