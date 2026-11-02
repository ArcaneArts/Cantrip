import { requestAlertNavigation } from "@/lib/alert-navigation";
import type {
  ProjectAlert,
  ChatSummary,
  SettingsBundle,
  WorkerSummary,
  AgentInteractionResponse,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { AgentInteractionPanel } from "@/components/chat/agent-interaction-panel";
import { TaskPlanReview } from "@/components/tasks/task-plan-review";
import { TaskSurface } from "@/components/tasks/task-surface";
import { unansweredRequiredTaskQuestions } from "@/components/tasks/task-review-state";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { getTask, respondToAgentInteractionRequest } from "@/lib/api";
import {
  getAlertInteraction,
  getAgentAlertDetail,
  getAlertGoal,
} from "@/lib/project-alert-api";
import { errorMessage } from "@/lib/error-message";

export type AlertSourceProps = {
  alert: ProjectAlert;
  chat?: ChatSummary;
  settings?: SettingsBundle;
  workers: WorkerSummary[];
  onRename(chatId: string, title: string): void;
  onOpenChat(chat: ChatSummary): Promise<unknown>;
};
export function AlertSource(props: AlertSourceProps) {
  const { alert, chat } = props;
  const open = useMutation({
    mutationFn: async () => {
      if (!chat) return;
      requestAlertNavigation(alert, chat.experience === "task");
      return props.onOpenChat(chat);
    },
  });
  if (!chat && alert.target.kind !== "interaction")
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        The originating chat is unavailable. Refresh the Alert Inbox to check
        its current state.
      </p>
    );
  return (
    <div className="space-y-4" data-alert-source={alert.id}>
      {alert.target.kind === "interaction" ? (
        <InteractionSource alert={alert} />
      ) : alert.target.kind === "task" ? (
        <TaskSource {...props} chat={chat!} />
      ) : alert.source === "agent" ? (
        <AgentSource alert={alert} />
      ) : alert.target.kind === "goal" ? (
        <GoalSource alert={alert} />
      ) : null}
      <SourceError error={open.error} />
      {chat ? (
        <Button
          variant="outline"
          size="sm"
          disabled={open.isPending}
          onClick={() => open.mutate()}
        >
          Open {chat.experience === "task" ? "task" : "chat"}
        </Button>
      ) : null}
    </div>
  );
}
function SourceError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="break-words text-sm text-destructive">
      {errorMessage(error)}
    </p>
  ) : null;
}
function InteractionSource({ alert }: { alert: ProjectAlert }) {
  const client = useQueryClient();
  const keys = useRef(new Map<string, string>());
  const responding = useRef(false);
  const source = useQuery({
    queryKey: ["alert-interaction", alert.sourceId],
    queryFn: () => getAlertInteraction(alert.sourceId),
    retry: false,
    refetchInterval: 5000,
  });
  const respond = useMutation({
    mutationFn: async (response: AgentInteractionResponse) => {
      const idempotencyKey =
        keys.current.get(alert.sourceId) ?? crypto.randomUUID();
      keys.current.set(alert.sourceId, idempotencyKey);
      return respondToAgentInteractionRequest(alert.sourceId, {
        idempotencyKey,
        response,
      });
    },
    onSettled: async () => {
      try {
        await Promise.all(
          [
            ["project-alerts"],
            ["project-alert-counts"],
            ["agent-requests", alert.chatId],
            ["alert-interaction", alert.sourceId],
            ["messages", alert.chatId],
            ["task", alert.chatId],
          ].map((queryKey) => client.invalidateQueries({ queryKey })),
        );
      } finally {
        responding.current = false;
      }
    },
  });
  const value = source.data;
  if (source.isPending) return <p role="status">Loading request…</p>;
  return (
    <>
      <SourceError error={source.error} />
      <SourceError error={respond.error} />
      {value && value.provenance.chatId === alert.chatId ? (
        value.status === "pending" ? (
          <AgentInteractionPanel
            requests={[value]}
            pendingRequestId={respond.isPending ? value.id : null}
            onRespond={(_id, response) => {
              if (responding.current) return;
              responding.current = true;
              respond.mutate(response);
            }}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            This request has already been resolved.
          </p>
        )
      ) : null}
      {source.isError ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void source.refetch()}
        >
          Retry request
        </Button>
      ) : null}
    </>
  );
}
function TaskSource(props: AlertSourceProps & { chat: ChatSummary }) {
  const { alert, chat } = props;
  const source = useQuery({
    queryKey: ["task", chat.id],
    queryFn: () => getTask(chat.id),
    retry: false,
    refetchInterval: 5000,
  });
  const task = source.data;
  const worker = props.workers.find((w) => w.workerId === chat.activeWorkerId);
  if (source.isPending) return <p role="status">Loading task…</p>;
  if (source.isError)
    return (
      <>
        <SourceError error={source.error} />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void source.refetch()}
        >
          Retry task
        </Button>
      </>
    );
  if (
    !task ||
    alert.target.kind !== "task" ||
    task.planningRound !== alert.target.planningRound
  )
    return (
      <p className="text-sm text-muted-foreground">
        The task has moved to another planning round. Refresh the Alert Inbox
        for its current actions.
      </p>
    );
  if (task.state === "review")
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {unansweredRequiredTaskQuestions(
            task.currentQuestions,
            task.currentAnswers,
          ).length
            ? "Answer the required questions, then review the plan."
            : "Review the plan and choose whether to begin implementation."}
        </p>
        <TaskPlanReview
          key={`${chat.id}:${task.planningRound}`}
          chat={chat}
          task={task}
          worker={worker}
          onReload={async () => (await source.refetch()).data ?? null}
        />
      </div>
    );
  if (task.state === "blocked" || task.state === "failed")
    return (
      <div className="min-h-64">
        <TaskSurface
          chat={chat}
          settings={props.settings}
          worker={worker}
          onRename={(title) => props.onRename(chat.id, title)}
        />
      </div>
    );
  return (
    <p role="status" className="text-sm text-muted-foreground">
      The task has advanced. Its current state is {task.state}.
    </p>
  );
}
function AgentSource({ alert }: { alert: ProjectAlert }) {
  const source = useQuery({
    queryKey: ["agent-alert-detail", alert.id, alert.sourceRevision],
    queryFn: () => getAgentAlertDetail(alert),
    retry: false,
  });
  return (
    <>
      <SourceError error={source.error} />
      {source.isError ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void source.refetch()}
        >
          Retry details
        </Button>
      ) : null}
      {source.data ? (
        <>
          <h3 className="font-medium">{source.data.title}</h3>
          <Markdown>{source.data.message}</Markdown>
          {source.data.nextStep ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                NEXT STEP
              </p>
              <Markdown>{source.data.nextStep}</Markdown>
            </div>
          ) : null}
        </>
      ) : source.isPending ? (
        <p role="status">Opening protected Alert…</p>
      ) : null}
    </>
  );
}
function GoalSource({ alert }: { alert: ProjectAlert }) {
  const source = useQuery({
    queryKey: ["alert-goal", alert.id, alert.sourceRevision],
    queryFn: () => getAlertGoal(alert),
    retry: false,
  });
  return (
    <>
      <SourceError error={source.error} />
      {source.isError ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void source.refetch()}
        >
          Retry details
        </Button>
      ) : null}
      {source.isPending ? (
        <p role="status">Opening protected Goal…</p>
      ) : source.data ? (
        <>
          <p className="text-sm font-medium">
            Goal state: {source.data.status}
          </p>
          <Markdown>{source.data.objective}</Markdown>
          <p className="text-sm text-muted-foreground">
            Open the chat to review the current Goal and its next action.
          </p>
        </>
      ) : null}
    </>
  );
}
