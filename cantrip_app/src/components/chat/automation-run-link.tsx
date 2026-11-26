import type { ChatAutomationSource } from "@cantrip/protocol/automations";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TooltipTarget } from "@/components/ui/tooltip";
import { getAutomationRun } from "@/lib/project-automation-api";

export function AutomationRunLink({
  source,
  label = `Sent via ${source.name}`,
}: {
  source: ChatAutomationSource;
  label?: string;
}) {
  const council = source.targetKind === "council";
  const [open, setOpen] = useState(false);
  const run = useQuery({
    queryKey: ["automation-run", source.automationId, source.runId],
    queryFn: () => getAutomationRun(source.automationId, source.runId),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipTarget tooltip={council ? "View automation run" : undefined}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">{label}</span>
            <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
          </button>
        </DialogTrigger>
      </TooltipTarget>
      <DialogContent closeTooltip={council ? "Close" : undefined}>
        <DialogHeader>
          <DialogTitle>{run.data?.name ?? source.name}</DialogTitle>
          <DialogDescription>Automation run</DialogDescription>
        </DialogHeader>
        {run.isPending ? <p role="status">Loading run…</p> : null}
        {run.isError ? <p role="alert">This run could not be opened.</p> : null}
        {run.data ? (
          <div className="min-w-0 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <time dateTime={run.data.scheduledFor}>
                {new Date(run.data.scheduledFor).toLocaleString()}
              </time>
              <span className="capitalize">{run.data.status}</span>
            </div>
            {run.data.error ? <p role="alert">{run.data.error}</p> : null}
            <h3 className="font-medium">Trigger prompt</h3>
            <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap wrap-anywhere">
              {run.data.prompt}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
