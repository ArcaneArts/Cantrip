import { councilAgentLink } from "@cantrip/protocol";

export function CouncilOriginLink({
  agentId,
  title,
}: {
  agentId: string;
  title: string;
}) {
  return (
    <a
      className="hover:text-foreground hover:underline"
      href={councilAgentLink(agentId)}
    >
      Sent via {title}
    </a>
  );
}
