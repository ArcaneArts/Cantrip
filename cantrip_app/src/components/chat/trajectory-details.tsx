import {
  computerUseActivitySummary,
  isPreviewActivity,
} from "./computer-use-activity";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";

import { Markdown } from "./markdown";
import { FileChangePreview } from "./file-change-preview";
import {
  trajectoryKindLabel,
  trajectoryLaneLabel,
  type TrajectoryEvent,
} from "./trajectory-model";

type TrajectoryDetailTab = "summary" | "preview" | "raw";

const detailTabs = [
  { id: "summary", label: "Summary" },
  { id: "preview", label: "Preview" },
  { id: "raw", label: "Raw" },
] as const;

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(6rem,0.35fr)_minmax(0,1fr)] gap-3 border-b py-2 text-xs last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono">{value}</dd>
    </div>
  );
}

function activitySummaryFields(
  event: TrajectoryEvent,
): Array<{ label: string; value: string }> {
  const activity = event.activity;
  if (!activity) return [];
  switch (activity.type) {
    case "computerUse":
      return [
        {
          label: "Origin",
          value:
            activity.source === "user-preview"
              ? "Preview operator"
              : "Agent MCP",
        },
        { label: "Operation", value: activity.operation },
        { label: "Operation ID", value: activity.operationId },
        { label: "Outcome", value: activity.outcome },
        { label: "Worker", value: activity.binding.workerId },
        { label: "Chat", value: activity.binding.chatId },
        ...(activity.binding.taskId
          ? [{ label: "Task", value: activity.binding.taskId }]
          : []),
        ...(activity.binding.sessionId
          ? [{ label: "Session", value: activity.binding.sessionId }]
          : []),
        ...(activity.requestId
          ? [{ label: "Request", value: activity.requestId }]
          : []),
        ...(activity.errorCode
          ? [{ label: "Error", value: activity.errorCode }]
          : []),
        ...(activity.target
          ? [
              {
                label: "Target",
                value: `${activity.target.targetId} · generation ${activity.target.targetGeneration}`,
              },
            ]
          : []),
        ...(activity.cursor
          ? [
              {
                label: "Cursor",
                value: `${activity.cursor.appearance.style} · ${activity.cursor.position.x}, ${activity.cursor.position.y} · revision ${activity.cursor.revision}`,
              },
            ]
          : []),
        ...(activity.observation
          ? [
              {
                label: "Observation",
                value: `#${activity.observation.revision}`,
              },
              {
                label: "Image metadata",
                value: `${activity.observation.image.width} × ${activity.observation.image.height} · ${activity.observation.image.byteCount} bytes · ${activity.observation.image.mediaType}`,
              },
              {
                label: "Image digest",
                value: activity.observation.image.sha256,
              },
            ]
          : []),
      ];
    case "instructionContext":
      return [
        { label: "Provenance", value: activity.provenance },
        {
          label: "Sources",
          value: activity.sources.join(" · ") || "Unavailable",
        },
        ...(activity.model ? [{ label: "Model", value: activity.model }] : []),
        ...(activity.provider
          ? [{ label: "Provider", value: activity.provider }]
          : []),
      ];
    case "command":
      return [
        { label: "Command", value: activity.command },
        { label: "Directory", value: activity.cwd },
        {
          label: "Exit",
          value:
            activity.exitCode === null
              ? "Not reported"
              : `${activity.exitCode}`,
        },
        ...(activity.outputTruncated
          ? [
              {
                label: "Output",
                value: "Tail retained; older output truncated",
              },
            ]
          : []),
      ];
    case "fileChange":
      return [
        { label: "Files", value: `${activity.changes.length}` },
        {
          label: "Paths",
          value: activity.changes.map((change) => change.path).join(" · "),
        },
      ];
    case "worktree":
      return [
        { label: "Operation", value: activity.operation },
        { label: "Result", value: activity.summary },
      ];
    case "plan":
      return [{ label: "Steps", value: `${activity.steps.length}` }];
    case "reasoning":
      return [{ label: "Summaries", value: `${activity.summary.length}` }];
    case "mcpToolCall":
      return [
        { label: "Server", value: activity.server },
        { label: "Tool", value: activity.tool },
      ];
    case "dynamicToolCall":
      return [
        {
          label: "Tool",
          value: `${activity.namespace ? `${activity.namespace}/` : ""}${activity.tool}`,
        },
      ];
    case "collabToolCall":
      return [
        { label: "Tool", value: activity.tool },
        {
          label: "Targets",
          value: activity.receiverThreadIds.join(" · ") || "None",
        },
      ];
    case "subAgent":
      return [
        { label: "Agent", value: activity.agentPath },
        { label: "Lifecycle", value: activity.kind },
      ];
    case "agentCommunication":
      return [
        { label: "Communication", value: activity.kind },
        { label: "Sender", value: activity.senderThreadId },
        {
          label: "Recipients",
          value: activity.receiverThreadIds.join(" · ") || "None",
        },
      ];
    case "webSearch":
      return [
        { label: "Query", value: activity.query || "Not captured" },
        ...(activity.action
          ? [{ label: "Action", value: activity.action }]
          : []),
      ];
    case "imageView":
      return [{ label: "Path", value: activity.path }];
    case "reviewMode":
      return [{ label: "Review mode", value: activity.state }];
    case "notice":
      return [{ label: "Level", value: activity.level }];
    case "usage":
      return [
        {
          label: "Tokens",
          value: activity.last.totalTokens.toLocaleString(),
        },
      ];
    case "rateLimit":
      return [
        {
          label: "Usage",
          value: activity.primary
            ? `${activity.primary.usedPercent.toFixed(0)}%`
            : "Unavailable",
        },
      ];
    case "turnSummary":
      return [
        {
          label: "Turn duration",
          value:
            activity.durationMs === null
              ? "Unavailable"
              : formatDuration(activity.durationMs),
        },
      ];
    case "contextCompaction":
      return [{ label: "Context", value: "Compacted" }];
  }
}

function Summary({ event }: { event: TrajectoryEvent }) {
  const durationMs = Math.max(0, event.updatedAtMs - event.startMs);
  const correlation = event.activity?.correlation;
  return (
    <dl className="px-3 py-2">
      <DetailField label="Event" value={event.label} />
      <DetailField
        label={
          event.activity && isPreviewActivity(event.activity)
            ? "Actor"
            : "Agent"
        }
        value={event.agentLabel}
      />
      <DetailField label="Type" value={trajectoryKindLabel(event.kind)} />
      <DetailField label="Lane" value={trajectoryLaneLabel(event.lane)} />
      <DetailField label="Status" value={event.status} />
      <DetailField
        label="Timing"
        value={`${event.timingQuality} · ${formatDuration(durationMs)}`}
      />
      {event.itemId ? <DetailField label="Item" value={event.itemId} /> : null}
      {correlation?.sourceMethod ? (
        <DetailField label="Source" value={correlation.sourceMethod} />
      ) : null}
      {event.threadId ? (
        <DetailField label="Thread" value={event.threadId} />
      ) : null}
      {event.turnId ? <DetailField label="Turn" value={event.turnId} /> : null}
      {event.diagnosticId ? (
        <DetailField label="Diagnostic" value={event.diagnosticId} />
      ) : null}
      {event.metrics?.map((field) => (
        <DetailField
          key={`${field.label}:${field.value}`}
          label={field.label}
          value={field.value}
        />
      ))}
      {activitySummaryFields(event).map((field) => (
        <DetailField
          key={`${field.label}:${field.value}`}
          label={field.label}
          value={field.value}
        />
      ))}
    </dl>
  );
}

function previewText(event: TrajectoryEvent): string | null {
  const activity = event.activity;
  if (!activity) return event.preview;
  switch (activity.type) {
    case "computerUse":
      return `${computerUseActivitySummary(activity)}. Protected operation metadata is retained in Trajectory; image pixels are not stored here.`;
    case "instructionContext":
      return activity.text;
    case "reasoning":
      return activity.summary.join("\n\n");
    case "plan":
      return activity.text || activity.explanation || event.preview;
    case "mcpToolCall":
      return activity.resultText ?? activity.error ?? event.preview;
    case "command":
      return activity.outputTail ?? activity.output ?? event.preview;
    case "reviewMode":
      return activity.review || event.preview;
    case "fileChange":
      return activity.changes
        .map(
          (change) =>
            `- **${change.kind}** \`${change.path}\`${change.latestLine ? `\n  - Latest line: \`${change.latestLine}\`` : ""}`,
        )
        .join("\n");
    case "worktree":
      return `${activity.operation}: ${activity.summary}`;
    case "collabToolCall":
      return activity.prompt ?? event.preview;
    case "subAgent":
      return `${activity.kind}: ${activity.agentPath}`;
    case "agentCommunication":
      return activity.message ?? `${activity.kind}: subagent communication`;
    case "webSearch":
      return [activity.query, activity.action].filter(Boolean).join("\n\n");
    case "imageView":
      return activity.path;
    case "notice":
      return activity.details ?? activity.message;
    case "usage":
      return `${activity.last.totalTokens.toLocaleString()} total tokens`;
    case "rateLimit":
      return activity.primary
        ? `${activity.primary.usedPercent.toFixed(0)}% used`
        : event.preview;
    case "turnSummary":
      return event.preview;
    case "contextCompaction":
      return "Conversation context compacted.";
    default:
      return event.preview;
  }
}

const PreviewContent = memo(function PreviewContent({
  command,
  outputTruncated,
  text,
}: {
  command: boolean;
  outputTruncated: boolean;
  text: string | null;
}) {
  if (!text) {
    return (
      <p className="p-4 text-xs text-muted-foreground">Preview unavailable.</p>
    );
  }
  if (command) {
    return (
      <div className="p-3">
        {outputTruncated ? (
          <p className="mb-2 text-xs text-amber-600">
            Older output was truncated; this is the retained output tail.
          </p>
        ) : null}
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/35 p-3 font-mono text-[11px] leading-4">
          {text}
        </pre>
      </div>
    );
  }
  return (
    <div className="max-h-full overflow-auto p-3 text-xs">
      <Markdown>{text}</Markdown>
    </div>
  );
});

function Preview({ event }: { event: TrajectoryEvent }) {
  const activity = event.activity;
  if (activity?.type === "fileChange") {
    return (
      <div className="p-3">
        <FileChangePreview changes={activity.changes} />
      </div>
    );
  }
  const command = activity?.type === "command";
  return (
    <PreviewContent
      command={command}
      outputTruncated={Boolean(
        activity?.type === "command" && activity.outputTruncated,
      )}
      text={previewText(event)}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="h-7 px-2 text-[10px]"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Raw({ event }: { event: TrajectoryEvent }) {
  const normalized = useMemo(
    () =>
      JSON.stringify(
        {
          id: event.id,
          kind: event.kind,
          lane: event.lane,
          status: event.status,
          timingQuality: event.timingQuality,
          startMs: event.startMs,
          updatedAtMs: event.updatedAtMs,
          completedAtMs: event.completedAtMs,
          correlation: event.activity?.correlation ?? null,
          activity: event.activity
            ? { ...event.activity, raw: undefined }
            : null,
        },
        null,
        2,
      ),
    [event],
  );
  const capture = event.activity?.raw
    ? JSON.stringify(event.activity.raw, null, 2)
    : null;
  return (
    <div className="space-y-4 p-3">
      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium">Normalized event</h4>
          <CopyButton text={normalized} />
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/35 p-3 font-mono text-[10px] leading-4">
          {normalized}
        </pre>
      </section>
      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium">Protected capture</h4>
          {capture ? <CopyButton text={capture} /> : null}
        </div>
        {capture ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/35 p-3 font-mono text-[10px] leading-4">
            {capture}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            Raw capture unavailable for this event.
          </p>
        )}
      </section>
    </div>
  );
}

export function TrajectoryDetails({
  event,
  initialTab = "summary",
  onBack,
}: {
  event: TrajectoryEvent;
  initialTab?: TrajectoryDetailTab;
  onBack(): void;
}) {
  const [tab, setTab] = useState<TrajectoryDetailTab>(initialTab);
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-slot="trajectory-details"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <Button
          aria-label="Back to trajectory events"
          className="size-7"
          onClick={onBack}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-xs font-medium">
          {event.label}
        </p>
      </header>
      <NavigationTabBar
        activeTab={tab}
        ariaLabel="Trajectory event details"
        className="border-b px-2"
        onTabChange={(nextTab) => setTab(nextTab as TrajectoryDetailTab)}
        tabs={detailTabs}
      />
      <div
        aria-label={`${detailTabs.find((candidate) => candidate.id === tab)?.label ?? "Details"} details`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        role="tabpanel"
      >
        {tab === "summary" ? (
          <Summary event={event} />
        ) : tab === "preview" ? (
          <Preview event={event} />
        ) : (
          <Raw event={event} />
        )}
      </div>
    </div>
  );
}
