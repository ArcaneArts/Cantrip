import { Plus, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  const agents = roster.data ?? [];
  const list = (items: CouncilAgent[]) => (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <Button
            aria-current={item.id === agent?.id ? "page" : undefined}
            className={cn(
              "w-full justify-start gap-2 px-2 font-normal",
              item.id === agent?.id && "bg-accent",
            )}
            onClick={() => select(item.id)}
            variant="ghost"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {item.title}
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
          </Button>
        </li>
      ))}
    </ul>
  );
  const hidden = agents.filter((item) => item.hidden && !item.archived);
  const archived = agents.filter((item) => item.archived);
  return (
    <nav
      aria-label="Council agents"
      className="flex min-h-0 flex-col gap-3 p-3"
    >
      <Button variant="outline" onClick={() => showEditor("new")}>
        <Plus className="size-4" /> New agent
      </Button>
      {roster.isError ? (
        <InlineAlert>{errorMessage(roster.error)}</InlineAlert>
      ) : null}
      {roster.isPending ? (
        <p className="px-2 text-sm text-muted-foreground">Loading agents…</p>
      ) : null}
      <div className="min-h-0 overflow-y-auto">
        {list(agents.filter((item) => !item.hidden && !item.archived))}
        {hidden.length ? (
          <details>
            <summary className="cursor-pointer rounded-md px-2 py-2 text-sm">
              Hidden agents
            </summary>
            {list(hidden)}
          </details>
        ) : null}
        {archived.length ? (
          <details>
            <summary className="cursor-pointer rounded-md px-2 py-2 text-sm">
              Archived agents
            </summary>
            {list(archived)}
          </details>
        ) : null}
      </div>
    </nav>
  );
}
