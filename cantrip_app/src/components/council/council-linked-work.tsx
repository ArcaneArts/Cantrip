import { councilLinkedWorkLink } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BriefcaseBusiness } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listCouncilLinkedWork } from "@/lib/api/council";

export function CouncilLinkedWork({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["council", "linked-work", agentId],
    queryFn: () => listCouncilLinkedWork(agentId),
    refetchInterval: 5_000,
  });
  const work = query.data ?? [];
  if (!open && !work.length) return null;

  return (
    <>
      {work.length ? (
        <Button
          aria-label="Delegated work"
          size="icon"
          variant="ghost"
          onClick={() => setOpen(true)}
        >
          <BriefcaseBusiness className="size-4" />
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delegated work</DialogTitle>
            <DialogDescription>
              Recent project chats and Tasks linked to this Council agent.
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-y">
            {work.map((item) => (
              <li key={item.chatId}>
                <a
                  href={councilLinkedWorkLink(item)}
                  className="flex items-center gap-2 rounded px-2 py-2 hover:bg-accent"
                >
                  <span className="flex-1 break-words text-sm">
                    {item.title ??
                      (item.targetKind === "task" ? "Task" : "Project chat")}
                  </span>
                  <span className="text-xs capitalize text-muted-foreground">
                    {item.status}
                  </span>
                  <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
