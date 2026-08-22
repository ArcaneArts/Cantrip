import type { ChatMessage, ChatSummary } from "@cantrip/protocol";
import {
  BrainCircuit,
  Check,
  CircleX,
  FileDiff,
  FileMinus2,
  FilePenLine,
  FilePlus2,
  Loader2,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";

import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import { cn } from "@/lib/utils";

import { AgentTrajectory } from "./agent-trajectory";
import { displayCommand } from "./command-display";
import {
  buildAgentInspectorProjectionSource,
  projectAgentInspector,
  type AgentInspectorCommand,
  type AgentInspectorFile,
  type AgentInspectorSnapshot,
} from "./inspect-model";

export const AGENT_INSPECT_CLOCK_INTERVAL_MS = 250;
export const AGENT_INSPECT_SCROLL_BOTTOM_TOLERANCE_PX = 24;
export const AGENT_INSPECT_SCROLLING_CARD_HEIGHT_PX = 176;
export const AGENT_INSPECT_THOUGHT_LINE_LIMIT = 3;

export function agentInspectorActive(status: ChatSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
}

export function formatInspectorElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function visibleInspectorCommands(
  commands: AgentInspectorSnapshot["commands"],
): AgentInspectorCommand[] {
  return commands.filter(({ presentation }) => presentation !== "hidden");
}

export function commandOutputIsAtBottom(input: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  return (
    input.scrollHeight - input.scrollTop - input.clientHeight <=
    AGENT_INSPECT_SCROLL_BOTTOM_TOLERANCE_PX
  );
}

export function inspectorSingleLine(value: string): string {
  return value.replace(/(?:\r\n|[\r\n])+/gu, " ↵ ");
}

export function latestInspectorThoughtLines(value: string): string {
  return value
    .split(/\r\n|[\r\n]/u)
    .filter((line) => line.trim().length > 0)
    .slice(-AGENT_INSPECT_THOUGHT_LINE_LIMIT)
    .join("\n");
}

export function inspectorCommandLayout(commandCount: number): {
  cardHeight: string;
  scrollable: boolean;
} {
  const count = Math.max(0, commandCount);
  if (count >= 4) {
    return {
      cardHeight: `${AGENT_INSPECT_SCROLLING_CARD_HEIGHT_PX}px`,
      scrollable: true,
    };
  }
  const gapsRem = Math.max(0, count - 1) * 0.5;
  return {
    cardHeight: count <= 1 ? "100%" : `calc((100% - ${gapsRem}rem) / ${count})`,
    scrollable: false,
  };
}

function filePreview(file: AgentInspectorFile): string {
  if (file.latestLine !== null) return inspectorSingleLine(file.latestLine);
  if (file.kind === "delete") return "File deleted";
  return "Preview unavailable";
}

function FileActivityIcon({ kind }: { kind: AgentInspectorFile["kind"] }) {
  if (kind === "add") {
    return <FilePlus2 className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (kind === "delete") {
    return <FileMinus2 className="size-3.5 shrink-0 text-destructive" />;
  }
  return <FilePenLine className="size-3.5 shrink-0 text-amber-500" />;
}

function FileLine({ file }: { file: AgentInspectorFile }) {
  const line = filePreview(file);
  const [transition, setTransition] = useState<{
    current: string;
    previous: string | null;
  }>({ current: line, previous: null });
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTransition((current) =>
      current.current === line
        ? current
        : { current: line, previous: current.current },
    );
  }, [line]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [transition.current]);

  return (
    <div
      aria-label={`Latest change in ${file.path}`}
      className="overflow-x-auto overscroll-x-contain"
      ref={scrollerRef}
    >
      <div className="relative h-5 min-w-max overflow-hidden pr-2 font-mono text-[11px] leading-5 text-muted-foreground">
        {transition.previous !== null ? (
          <span
            aria-hidden="true"
            className="absolute left-0 top-0 whitespace-pre animate-out fade-out slide-out-to-top-1 duration-150 motion-reduce:hidden"
            onAnimationEnd={() =>
              setTransition((current) => ({ ...current, previous: null }))
            }
          >
            {transition.previous}
          </span>
        ) : null}
        <span
          className="block whitespace-pre animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
          key={`${file.id}:${file.updatedAtMs}:${transition.current}`}
        >
          {transition.current}
        </span>
      </div>
    </div>
  );
}

function ActiveFileRow({ file }: { file: AgentInspectorFile }) {
  return (
    <li
      className="min-w-0 animate-in fade-in slide-in-from-right-1 duration-150 motion-reduce:animate-none"
      data-file-path={file.path}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FileActivityIcon kind={file.kind} />
        <span className="min-w-0 truncate text-xs" title={file.path}>
          {file.path}
        </span>
      </div>
      <div className="ml-[1.375rem] mt-0.5 min-w-0">
        <FileLine file={file} />
      </div>
    </li>
  );
}

function CommandOutput({ command }: { command: AgentInspectorCommand }) {
  const outputRef = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);

  useEffect(() => {
    const output = outputRef.current;
    if (!output || !followingRef.current) return;
    output.scrollTop = output.scrollHeight;
  }, [command.output, command.outputTruncated]);

  const handleScroll = (event: UIEvent<HTMLPreElement>) => {
    const output = event.currentTarget;
    followingRef.current = commandOutputIsAtBottom(output);
  };

  return (
    <pre
      aria-label={`Output from ${displayCommand(command.command)}`}
      className="min-h-0 flex-1 overflow-auto overscroll-contain p-2 font-mono text-[10px] leading-4 text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onScroll={handleScroll}
      ref={outputRef}
      tabIndex={0}
    >
      {command.outputTruncated ? (
        <span className="text-amber-500">
          … older output removed (latest 256 KiB retained) …{"\n"}
        </span>
      ) : null}
      {command.output || (
        <span className="text-muted-foreground">Waiting for output…</span>
      )}
    </pre>
  );
}

function RunningCommandCard({
  command,
  height,
}: {
  command: AgentInspectorCommand;
  height: string;
}) {
  const unsuccessful =
    command.status === "failed" || command.status === "declined";
  const commandText = inspectorSingleLine(displayCommand(command.command));
  return (
    <article
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/15 shadow-inner",
        "transition-[height,opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        command.presentation === "visible" &&
          "animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none",
        command.presentation === "exiting" &&
          "translate-y-1 scale-[0.99] opacity-0",
        unsuccessful && "border-destructive/40",
      )}
      data-command-id={command.id}
      data-command-presentation={command.presentation}
      style={{ height }}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/25 px-2">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
        <code
          className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[10px] leading-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          title={commandText}
        >
          {commandText}
        </code>
        <time className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatInspectorElapsed(command.elapsedMs)}
        </time>
      </header>
      <CommandOutput command={command} />
      {command.completedAtMs !== null ? (
        <footer
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 border-t px-2 text-[10px]",
            unsuccessful ? "text-destructive" : "text-emerald-600",
          )}
        >
          {unsuccessful ? (
            <CircleX className="size-3" />
          ) : (
            <Check className="size-3" />
          )}
          {command.status === "declined"
            ? "Declined"
            : unsuccessful
              ? `Exited ${command.exitCode ?? 1}`
              : "Completed"}
        </footer>
      ) : null}
    </article>
  );
}

function RecentCommandRows({
  commands,
}: {
  commands: AgentInspectorSnapshot["recentCommands"];
}) {
  if (commands.length === 0) return null;
  return (
    <section aria-label="Recently completed commands" className="mt-3">
      <h3 className="sr-only">Recently completed commands</h3>
      <ul className="space-y-1">
        {commands.map((command) => (
          <li
            className="agent-inspect-recent-command flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground motion-reduce:animate-none"
            data-command-id={command.id}
            key={command.id}
          >
            <SquareTerminal className="size-3.5 shrink-0" />
            <code
              className="min-w-0 flex-1 truncate font-mono"
              title={inspectorSingleLine(displayCommand(command.command))}
            >
              {inspectorSingleLine(displayCommand(command.command))}
            </code>
            {command.status === "failed" || command.status === "declined" ? (
              <CircleX className="size-3 shrink-0 text-destructive" />
            ) : (
              <Check className="size-3 shrink-0 text-emerald-600" />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentInspectPresentation({
  snapshot,
}: {
  snapshot: AgentInspectorSnapshot;
}) {
  const commands = visibleInspectorCommands(snapshot.commands);
  const layout = inspectorCommandLayout(commands.length);
  const thoughtText = snapshot.thought
    ? latestInspectorThoughtLines(snapshot.thought.text)
    : null;
  const hasSummary =
    snapshot.thought !== null ||
    snapshot.files.length > 0 ||
    snapshot.recentCommands.length > 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-slot="agent-inspect-content"
    >
      <div
        className={cn(
          "min-h-0 shrink-0 overflow-y-auto p-3",
          commands.length > 0 ? "max-h-[45%] border-b" : "flex-1",
        )}
      >
        {snapshot.thought ? (
          <section aria-labelledby="agent-inspect-thought-heading">
            <div className="flex items-center gap-2">
              <BrainCircuit className="size-3.5 text-violet-500" />
              <h3
                className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                id="agent-inspect-thought-heading"
              >
                Latest thought
              </h3>
            </div>
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-foreground/85 animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none">
              {thoughtText}
            </p>
          </section>
        ) : null}

        {snapshot.files.length > 0 ? (
          <section
            aria-labelledby="agent-inspect-files-heading"
            className={cn(snapshot.thought && "mt-4 border-t pt-3")}
          >
            <div className="flex items-center gap-2">
              <FileDiff className="size-3.5 text-sky-500" />
              <h3
                className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                id="agent-inspect-files-heading"
              >
                Editing now
              </h3>
            </div>
            <ul className="mt-2 space-y-2.5">
              {snapshot.files.map((file) => (
                <ActiveFileRow file={file} key={file.path} />
              ))}
            </ul>
          </section>
        ) : null}

        <RecentCommandRows commands={snapshot.recentCommands} />

        {!hasSummary ? (
          <div className="grid h-full min-h-24 place-items-center text-center text-xs text-muted-foreground">
            <div>
              <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
              Watching live activity…
            </div>
          </div>
        ) : null}
      </div>

      {commands.length > 0 ? (
        <section
          aria-label="Running commands"
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-2 p-3",
            layout.scrollable && "overflow-y-auto overscroll-contain",
          )}
          data-command-layout={layout.scrollable ? "scroll" : "equal"}
        >
          {commands.map((command) => (
            <RunningCommandCard
              command={command}
              height={layout.cardHeight}
              key={command.id}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

export type AgentInspectTab = "trajectory" | "state";

export const AGENT_INSPECT_TABS = [
  { id: "trajectory", label: "Trajectory" },
  { id: "state", label: "State" },
] as const;

function AgentInspectInactive() {
  return (
    <div
      className="grid h-full place-items-center p-6 text-center"
      data-slot="agent-inspect-inactive"
    >
      <div>
        <p className="text-sm font-medium">Inactive</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Shows activity when agent is working
        </p>
      </div>
    </div>
  );
}

function AgentInspectLiveContent({
  messages,
  visible,
}: {
  messages: ChatMessage[];
  visible: boolean;
}) {
  const source = useMemo(
    () => buildAgentInspectorProjectionSource(messages),
    [messages],
  );
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    setClockMs(Date.now());
  }, [source, visible]);

  useEffect(() => {
    if (!visible) return;
    const interval = window.setInterval(
      () => setClockMs(Date.now()),
      AGENT_INSPECT_CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [visible]);

  const nowMs = visible ? Math.max(clockMs, Date.now()) : clockMs;
  const snapshot = useMemo(
    () => projectAgentInspector({ active: true, nowMs, source }),
    [nowMs, source],
  );
  return <AgentInspectPresentation snapshot={snapshot} />;
}

export function AgentInspectStateContent({
  active,
  messages,
  visible,
}: {
  active: boolean;
  messages: ChatMessage[];
  visible: boolean;
}) {
  if (!active) return <AgentInspectInactive />;
  return <AgentInspectLiveContent messages={messages} visible={visible} />;
}

export function AgentInspectContent({
  active,
  integratedPanelHeader = false,
  initialTab = "trajectory",
  messages,
  onBackToCurrent,
  onTabChange,
  tab,
  trajectoryTargetKey,
  visible,
}: {
  active: boolean;
  integratedPanelHeader?: boolean;
  initialTab?: AgentInspectTab;
  messages: ChatMessage[];
  onBackToCurrent?(): void;
  onTabChange?(tab: AgentInspectTab): void;
  tab?: AgentInspectTab;
  trajectoryTargetKey?: string | null;
  visible: boolean;
}) {
  const [internalTab, setInternalTab] = useState<AgentInspectTab>(initialTab);
  const activeTab = tab ?? internalTab;
  const selectTab = (nextTab: AgentInspectTab) => {
    if (tab === undefined) setInternalTab(nextTab);
    onTabChange?.(nextTab);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-slot="agent-observation-content"
    >
      <NavigationTabBar
        activeTab={activeTab}
        ariaLabel="Inspect view"
        className={cn(
          "border-b px-3",
          integratedPanelHeader && "h-11 pl-24 pr-10",
        )}
        onTabChange={selectTab}
        tabs={AGENT_INSPECT_TABS}
      />
      <div
        aria-label={`${activeTab === "trajectory" ? "Trajectory" : "State"} view`}
        className="min-h-0 flex-1 overflow-hidden"
        role="tabpanel"
      >
        {activeTab === "trajectory" ? (
          <AgentTrajectory
            active={active}
            messages={messages}
            onBackToCurrent={onBackToCurrent}
            targetTurnKey={trajectoryTargetKey}
            visible={visible}
          />
        ) : (
          <AgentInspectStateContent
            active={active}
            messages={messages}
            visible={visible}
          />
        )}
      </div>
    </div>
  );
}
