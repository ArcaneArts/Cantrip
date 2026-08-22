import { ArrowLeft, Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";

import { Markdown } from "./markdown";
import { trajectoryKindLabel, type TrajectoryEvent } from "./trajectory-model";

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

function Summary({ event }: { event: TrajectoryEvent }) {
  const durationMs = Math.max(0, event.updatedAtMs - event.startMs);
  const correlation = event.activity?.correlation;
  return (
    <dl className="px-3 py-2">
      <DetailField label="Event" value={event.label} />
      <DetailField label="Type" value={trajectoryKindLabel(event.kind)} />
      <DetailField label="Lane" value={event.lane} />
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
      {event.activity?.type === "instructionContext" ? (
        <>
          <DetailField label="Provenance" value={event.activity.provenance} />
          <DetailField
            label="Sources"
            value={event.activity.sources.join(" · ") || "Unavailable"}
          />
          {event.activity.model ? (
            <DetailField label="Model" value={event.activity.model} />
          ) : null}
          {event.activity.provider ? (
            <DetailField label="Provider" value={event.activity.provider} />
          ) : null}
        </>
      ) : null}
    </dl>
  );
}

function previewText(event: TrajectoryEvent): string | null {
  const activity = event.activity;
  if (!activity) return event.preview;
  switch (activity.type) {
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
    default:
      return event.preview;
  }
}

function Preview({ event }: { event: TrajectoryEvent }) {
  const text = previewText(event);
  if (!text) {
    return (
      <p className="p-4 text-xs text-muted-foreground">Preview unavailable.</p>
    );
  }
  if (event.activity?.type === "command") {
    return (
      <div className="p-3">
        {event.activity.outputTruncated ? (
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
