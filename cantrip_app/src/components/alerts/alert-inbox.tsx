import type {
  ChatSummary,
  ProjectAlert,
  SettingsBundle,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { getProjectAlerts, getAgentAlertDetail } from "@/lib/project-alert-api";
import { errorMessage } from "@/lib/error-message";
import { AlertSource } from "./alert-source";
const labels: Record<ProjectAlert["kind"], string> = {
  permission: "Permission required",
  "user-input": "Input requested",
  "task-questions": "Review questions and plan",
  "plan-ready": "Plan ready for review",
  blocked: "Work needs your attention",
  "goal-stalled": "Goal needs your attention",
  "action-required": "Action required",
};
export function AlertInbox({
  projectId,
  chats,
  workers,
  settings,
  onRename,
  onOpenChat,
}: {
  projectId: string;
  chats: ChatSummary[];
  workers: WorkerSummary[];
  settings?: SettingsBundle;
  onRename(chatId: string, title: string): void;
  onOpenChat(chat: ChatSummary): Promise<unknown>;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const after = cursors.at(-1) ?? null;
  const alerts = useQuery({
    queryKey: ["project-alerts", projectId, after],
    queryFn: () => getProjectAlerts(projectId, after),
    retry: false,
    refetchInterval: 5000,
  });
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Alert Inbox">
      <PanelToolbar>
        <Bell className="size-4" />
        <h2 className="font-medium">Alert Inbox</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          title="Refresh alerts"
          aria-label="Refresh alerts"
          disabled={alerts.isFetching}
          onClick={() => void alerts.refetch()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </PanelToolbar>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
        {alerts.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading alerts…
          </p>
        ) : null}
        {alerts.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(alerts.error)}
            </p>
            <Button variant="outline" onClick={() => void alerts.refetch()}>
              Reconnect
            </Button>
          </div>
        ) : null}
        {alerts.data?.items.length === 0 ? (
          <div className="grid min-h-48 place-content-center gap-2 text-center text-muted-foreground">
            <Bell className="mx-auto size-8 opacity-50" />
            <h3 className="text-base font-medium">
              {after ? "No alerts on this page" : "No active alerts"}
            </h3>
            <p className="text-sm">
              Work that needs your attention will appear here.
            </p>
          </div>
        ) : null}
        <div className="mx-auto max-w-5xl space-y-3">
          {alerts.data?.items.map((alert) => {
            const chat = chats.find((c) => c.id === alert.chatId);
            const open = expanded === alert.id;
            return (
              <article
                key={alert.id}
                className="rounded-xl border bg-card/30"
                data-alert-id={alert.id}
              >
                <button
                  type="button"
                  className="flex w-full items-start gap-3 rounded-xl p-4 text-left hover:bg-muted/30"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : alert.id)}
                >
                  <Bell className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {alert.source === "agent" ? (
                        <AgentAlertSummary alert={alert} />
                      ) : (
                        labels[alert.kind]
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {chat?.title ?? "Chat unavailable"} ·{" "}
                      {alert.source === "agent"
                        ? `Agent: ${chat?.title ?? "originating agent"}`
                        : "System"}
                    </span>
                    <time
                      className="mt-1 block text-xs text-muted-foreground"
                      dateTime={alert.createdAt}
                    >
                      {new Date(alert.createdAt).toLocaleString()}
                    </time>
                  </span>
                  {open ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
                {open ? (
                  <div className="border-t p-4">
                    <AlertSource
                      alert={alert}
                      chat={chat}
                      settings={settings}
                      workers={workers}
                      onRename={onRename}
                      onOpenChat={onOpenChat}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        {cursors.length > 1 || alerts.data?.nextCursor ? (
          <nav
            aria-label="Alert pages"
            className="mx-auto mt-4 flex max-w-5xl justify-between gap-2"
          >
            <Button
              variant="outline"
              disabled={cursors.length < 2}
              onClick={() => {
                setCursors((c) => c.slice(0, -1));
                setExpanded(null);
              }}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!alerts.data?.nextCursor}
              onClick={() => {
                if (alerts.data?.nextCursor)
                  setCursors((c) => [...c, alerts.data.nextCursor]);
                setExpanded(null);
              }}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </div>
    </section>
  );
}

function AgentAlertSummary({ alert }: { alert: ProjectAlert }) {
  const detail = useQuery({
    queryKey: ["agent-alert-detail", alert.id, alert.sourceRevision],
    queryFn: () => getAgentAlertDetail(alert),
    retry: false,
  });
  return <>{detail.data?.title ?? labels[alert.kind]}</>;
}
