import {
  councilHistoryReadInputSchema,
  standaloneChatIdentitySchema,
} from "@cantrip/protocol";
import { useEffect } from "react";

export function useCouncilHistoryLink(
  enabled: boolean,
  openHistory: (agentId: string, messageId: string) => void,
  setAppMode: (mode: "council") => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const openLink = () => {
      const params = new URLSearchParams(window.location.search);
      const agent = standaloneChatIdentitySchema.safeParse(
        params.get("councilAgent"),
      );
      const message = councilHistoryReadInputSchema.safeParse({
        messageId: params.get("message"),
      });
      if (agent.success && message.success) {
        setAppMode("council");
        openHistory(agent.data, message.data.messageId);
      }
    };
    openLink();
    window.addEventListener("popstate", openLink);
    return () => window.removeEventListener("popstate", openLink);
  }, [enabled, openHistory, setAppMode]);
}
