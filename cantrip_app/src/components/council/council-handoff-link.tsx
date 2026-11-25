import type { CouncilPeerMessageSource } from "@cantrip/protocol";
import { ArrowUpRight } from "lucide-react";

export function CouncilHandoffLink({
  agentId,
  source,
}: {
  agentId: string;
  source: CouncilPeerMessageSource;
}) {
  const sent = agentId === source.senderAgentId;
  const peer = sent ? source.recipientAgentId : source.senderAgentId;
  const query = new URLSearchParams({ councilAgent: agentId, peerAgent: peer });
  return (
    <a
      className="inline-flex w-fit items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      data-slot="council-peer-handoff"
      href={`?${query}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        window.history.pushState(null, "", `?${query}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {sent ? "Sent to Council agent" : "Received from Council agent"}
      <ArrowUpRight aria-hidden className="size-3" />
    </a>
  );
}
