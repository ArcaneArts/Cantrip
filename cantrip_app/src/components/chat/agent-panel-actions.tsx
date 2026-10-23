import type { ChatSummary } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";

import { CustomizationPanel } from "./customization-panel";
import {
  activeChatRelocationJob,
  ChatRelocationDialog,
  isChatRelocationActive,
  latestChatRelocationJob,
} from "./chat-relocation-dialog";
import { ContentHeaderActions } from "@/components/workspace/content-header-actions";
import { getChatRelocations } from "@/lib/api";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";

type Relocation = Pick<
  ComponentProps<typeof ChatRelocationDialog>,
  "available" | "placement" | "statuses" | "synchronizationPolicy"
>;

/** Actions and dialogs belong to this chat, including when another pane is focused. */
export function AgentPanelActions({
  chat,
  consoleActive,
  consolePending,
  inspectActive,
  onToggleConsole,
  onToggleInspect,
  relocation,
}: {
  chat: ChatSummary;
  consoleActive: boolean;
  consolePending: boolean;
  inspectActive: boolean;
  onToggleConsole(): void;
  onToggleInspect(): void;
  relocation?: Relocation;
}) {
  const [customizationsOpen, setCustomizationsOpen] = useState(false);
  const [relocationOpen, setRelocationOpen] = useState(false);
  const live = useAppLiveStatus() === "live";
  useAppLiveScope({ kind: "chat", chatId: chat.id });
  const jobs = useQuery({
    enabled: Boolean(relocation?.available),
    queryKey: ["chat-relocation-jobs", chat.id],
    queryFn: () => getChatRelocations(chat.id),
    refetchInterval: (query) =>
      live
        ? false
        : query.state.data?.some(isChatRelocationActive)
          ? 2_000
          : 10_000,
    retry: false,
  });
  const active = activeChatRelocationJob(jobs.data ?? []);
  const current = active ?? latestChatRelocationJob(jobs.data ?? []);
  return (
    <>
      <ContentHeaderActions
        compact
        chat={{
          consoleActive,
          consolePending,
          inspectActive,
          inspectCustomizations: () => setCustomizationsOpen(true),
          toggleConsole: onToggleConsole,
          toggleInspect: onToggleInspect,
          relocation: {
            active: Boolean(active),
            available: Boolean(
              relocation?.available &&
              (relocation.placement.workers.length > 1 || current),
            ),
            open: relocationOpen,
            problem:
              current?.state === "blocked" || current?.state === "failed",
            show: () => setRelocationOpen(true),
          },
        }}
      />
      <CustomizationPanel
        chatId={chat.id}
        chatTitle={chat.title}
        open={customizationsOpen}
        onOpenChange={setCustomizationsOpen}
      />
      {relocation ? (
        <ChatRelocationDialog
          {...relocation}
          chat={chat}
          jobs={jobs.data ?? []}
          jobsError={jobs.error}
          jobsLoading={jobs.isLoading}
          open={relocationOpen}
          onOpenChange={setRelocationOpen}
        />
      ) : null}
    </>
  );
}
