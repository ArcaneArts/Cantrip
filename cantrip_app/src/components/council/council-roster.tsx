import { Plus, Star } from "lucide-react";
import { useId } from "react";

import {
  TooltipButton,
  TooltipProvider,
  TooltipTarget,
} from "@/components/ui/tooltip";
import { InlineAlert } from "@/components/ui/inline-alert";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import type { CouncilAgent } from "@/lib/api/council";
import type { CouncilWorkspaceController } from "./use-council-workspace";

export function CouncilRoster({
  controller,
}: {
  controller: CouncilWorkspaceController;
}) {
  const { agent, roster, select, showEditor } = controller;
  const rosterId = useId();
  const agents = roster.data ?? [];
  const list = (items: CouncilAgent[]) => (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <TooltipButton
            tooltip={`Open ${item.title}`}
            tooltipSide="right"
            aria-current={item.id === agent?.id ? "page" : undefined}
            aria-describedby={item.role ? `${rosterId}-${item.id}` : undefined}
            aria-label={item.title}
            className={cn(
              "h-auto min-h-9 w-full justify-start px-2 py-1.5 font-normal",
              item.id === agent?.id && "bg-accent",
            )}
            onClick={() => select(item.id)}
            variant="ghost"
          >
            <span className="grid min-w-0 flex-1 text-left">
              <span className="truncate">{item.title}</span>
              {item.role ? (
                <span
                  id={`${rosterId}-${item.id}`}
                  className="truncate text-xs text-muted-foreground"
                >
                  {item.role}
                </span>
              ) : null}
            </span>
            {item.paused && !item.archived ? (
              <span className="text-xs text-muted-foreground">Paused</span>
            ) : null}
            {item.primary ? (
              <Star
                aria-label="Primary"
                className="size-3.5 text-muted-foreground"
              />
            ) : null}
          </TooltipButton>
        </li>
      ))}
    </ul>
  );
  const hidden = agents.filter((item) => item.hidden && !item.archived);
  const archived = agents.filter((item) => item.archived);
  return (
    <TooltipProvider disableHoverableContent>
      <nav
        aria-label="Council agents"
        className="flex min-h-0 flex-1 flex-col gap-3 p-3"
      >
        <TooltipButton
          tooltip="New agent"
          tooltipSide="right"
          variant="outline"
          onClick={() => showEditor("new")}
        >
          <Plus className="size-4" /> New agent
        </TooltipButton>
        {roster.isError ? (
          <InlineAlert>{errorMessage(roster.error)}</InlineAlert>
        ) : null}
        {roster.isPending ? (
          <p className="px-2 text-sm text-muted-foreground">Loading agents…</p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list(agents.filter((item) => !item.hidden && !item.archived))}
          {hidden.length ? (
            <details>
              <TooltipTarget tooltip="Hidden agents" side="right">
                <summary className="cursor-pointer rounded-md px-2 py-2 text-sm">
                  Hidden agents
                </summary>
              </TooltipTarget>
              {list(hidden)}
            </details>
          ) : null}
          {archived.length ? (
            <details>
              <TooltipTarget tooltip="Archived agents" side="right">
                <summary className="cursor-pointer rounded-md px-2 py-2 text-sm">
                  Archived agents
                </summary>
              </TooltipTarget>
              {list(archived)}
            </details>
          ) : null}
        </div>
      </nav>
    </TooltipProvider>
  );
}
