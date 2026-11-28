import { useAlertDestinationReveal } from "@/lib/alert-navigation";
import type { ChatSummary } from "@cantrip/protocol";
import { useState, useRef, useCallback, type ReactNode } from "react";

import { AgentInspectStateContent } from "@/components/chat/agent-inspect-content";
import { AgentTrajectory } from "@/components/chat/agent-trajectory";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { useChatMessageHistory } from "@/lib/use-chat-message-history";
import { TaskInteractionRequests } from "./task-interaction-requests";

export const TASK_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "trajectory", label: "Trajectory" },
  { id: "state", label: "State" },
  { id: "chat", label: "Chat" },
] as const;
type TaskDetailTab = (typeof TASK_DETAIL_TABS)[number]["id"];

function TaskActivityView({
  chat,
  tab,
  visible,
}: {
  chat: ChatSummary;
  tab: "trajectory" | "state";
  visible: boolean;
}) {
  const active =
    chat.status === "running" || chat.status === "waiting-for-approval";
  const live = useAppLiveStatus() === "live";
  const messages = useChatMessageHistory({
    chatId: chat.id,
    enabled: visible,
    autoLoadOlder: true,
    refetchInterval: liveResourceRefreshInterval(live, active ? 1_000 : 5_000),
  });
  const content =
    tab === "trajectory" ? (
      <AgentTrajectory
        active={active}
        eventOrder="newest-first"
        messages={messages.data}
        nativeTurnSettings={messages.nativeTurnSettings}
        visible={visible}
      />
    ) : (
      <AgentInspectStateContent
        active={active}
        messages={messages.data}
        visible={visible}
      />
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4">
        <TaskInteractionRequests chat={chat} visible={visible} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </div>
  );
}

export function TaskDetailTabs({
  chat,
  chatContent,
  overview,
  showActivity = true,
  visible,
}: {
  chat: ChatSummary;
  chatContent?: ReactNode;
  overview(visible: boolean): ReactNode;
  showActivity?: boolean;
  visible: boolean;
}) {
  const [tab, setTab] = useState<TaskDetailTab>("overview");
  const root = useRef<HTMLDivElement>(null);
  const revealOverview = useCallback(() => setTab("overview"), []);
  useAlertDestinationReveal(chat.projectId, chat.id, root, revealOverview);
  const activeTab = showActivity ? tab : "overview";
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {showActivity ? (
        <NavigationTabBar<TaskDetailTab>
          activeTab={activeTab}
          ariaLabel="Task views"
          className="border-b px-2 [&_button]:h-10 [&_button]:flex-1 [&_button]:px-2 [&_button]:text-sm"
          onTabChange={setTab}
          tabs={TASK_DETAIL_TABS}
        />
      ) : null}
      <div
        aria-hidden={activeTab !== "overview"}
        aria-label={showActivity ? "Overview" : undefined}
        role={showActivity ? "tabpanel" : undefined}
        className={
          activeTab === "overview" ? "flex min-h-0 flex-1 flex-col" : "hidden"
        }
      >
        {overview(visible && activeTab === "overview")}
      </div>
      {activeTab === "trajectory" || activeTab === "state" ? (
        <div
          aria-label={activeTab === "trajectory" ? "Trajectory" : "State"}
          role="tabpanel"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <TaskActivityView chat={chat} tab={activeTab} visible={visible} />
        </div>
      ) : activeTab === "chat" ? (
        <div
          aria-label="Chat"
          role="tabpanel"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {chatContent}
        </div>
      ) : null}
    </div>
  );
}
