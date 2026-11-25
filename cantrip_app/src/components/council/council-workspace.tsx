import type { SettingsBundle, WorkerSummary } from "@cantrip/protocol";
import {
  ArrowLeft,
  FolderOpen,
  NotebookPen,
  Search,
  Settings2,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import { ChatTranscript } from "@/components/chat/chat-transcript";
import { COUNCIL_CHAT_SURFACE_CAPABILITIES } from "@/components/chat/chat-surface-capabilities";
import { useChatExecutionControls } from "@/components/chat/use-chat-execution-controls";
import type { AppToastInput } from "@/components/ui/app-toast";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { CouncilAgent } from "@/lib/api/council";
import { resolveStandaloneChatFilePath } from "@/lib/api/files";
import { errorMessage } from "@/lib/error-message";

import { CouncilAgentEditor } from "./council-agent-editor";
import { CouncilHistoryDialog } from "./council-history-dialog";
import { CouncilMemoryEditor } from "./council-memory-editor";
import { CouncilPeerDialog } from "./council-peer-dialog";
import { CouncilProjectApprovals } from "./council-project-approvals";
import { CouncilLinkedWork } from "./council-linked-work";
import { CouncilRoster } from "./council-roster";
import { CouncilRoutines } from "./council-routines";
import type { CouncilWorkspaceController } from "./use-council-workspace";

type Props = {
  controller: CouncilWorkspaceController;
  compact: boolean;
  desktopRuntime: boolean;
  narrowViewport: boolean;
  onConfigureModels(): void;
  onToast(toast: AppToastInput): void;
  settings?: SettingsBundle;
  workers: WorkerSummary[];
};

export function CouncilWorkspace(props: Props) {
  const { controller, compact } = props;
  const { agent, editor, showEditor } = controller;
  return (
    <>
      {agent ? (
        <CouncilConversation key={agent.id} {...props} agent={agent} />
      ) : compact ? (
        <CouncilRoster controller={controller} />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <UsersRound className="size-6 text-muted-foreground" />
            <h1 className="font-medium">
              {controller.roster.data?.length
                ? "Choose a Council agent"
                : "Create your first Council agent"}
            </h1>
            {!controller.roster.data?.length ? (
              <Button onClick={() => showEditor("new")}>New agent</Button>
            ) : null}
          </div>
        </div>
      )}
      {editor ? (
        <CouncilAgentEditor
          key={editor === "new" ? "new" : `${editor.id}:${editor.revision}`}
          controller={controller}
        />
      ) : null}
    </>
  );
}

function CouncilConversation({
  agent,
  compact,
  controller,
  desktopRuntime,
  narrowViewport,
  onConfigureModels,
  onToast,
  settings,
  workers,
}: Props & { agent: CouncilAgent }) {
  const {
    chat,
    closeHistory,
    closePeer,
    history,
    openHistory,
    peerId,
    roster,
    select,
    showEditor,
  } = controller;
  const [filesOpen, setFilesOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const { interrupt } = useChatExecutionControls({
    chatId: agent.id,
    projectId: null,
    projectChatQueryKey: ["council", "chat", agent.id],
  });
  const openFile = (reference: string) => {
    void resolveStandaloneChatFilePath(agent.id, reference).then(
      (path) => {
        closeHistory();
        setFilePath(path);
        setFilesOpen(true);
      },
      (error: unknown) =>
        onToast({
          title: "Could not open agent file",
          message: errorMessage(error),
          tone: "error",
        }),
    );
  };
  const worker = workers.find(({ workerId }) => workerId === agent.workerId);
  const status =
    worker && !worker.online
      ? "Worker offline. Messages queue until it reconnects."
      : agent.scratchStatus === "provisioning"
        ? "Preparing the agent’s workspace. Messages will queue in the meantime."
        : agent.scratchStatus === "failed"
          ? "The worker could not prepare this agent’s workspace."
          : null;
  const recovery = chat.data?.providerRecovery;
  const recoveryActive =
    recovery?.phase === "pending" ||
    recovery?.phase === "blocked" ||
    recovery?.phase === "switching" ||
    recovery?.phase === "continuation-queued";
  const providerStatus =
    recovery?.phase === "blocked"
      ? `${recovery.from} reached its quota. Council is waiting for an available route.`
      : recovery?.phase === "switching" && recovery.to
        ? `Switching from ${recovery.from} to ${recovery.to}.`
        : recovery?.phase === "pending"
          ? `${recovery.from} reached its quota. Looking for an alternate route.`
          : recovery?.to
            ? `Switched from ${recovery.from} to ${recovery.to}.`
            : null;
  return (
    <div
      data-slot="council-conversation"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {compact ? (
          <Button
            aria-label="Back to Council agents"
            size="icon"
            variant="ghost"
            onClick={() => select(null)}
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {agent.title}
        </h1>
        <CouncilProjectApprovals agentId={agent.id} />
        <CouncilLinkedWork agentId={agent.id} />
        <CouncilRoutines agentId={agent.id} />
        <Button
          aria-label="Search Council history"
          size="icon"
          variant="ghost"
          onClick={() => openHistory(agent.id)}
        >
          <Search className="size-4" />
        </Button>
        <Button
          aria-label="Edit Council agent"
          size="icon"
          variant="ghost"
          onClick={() => showEditor(agent)}
        >
          <Settings2 className="size-4" />
        </Button>
        <Button
          aria-label="Edit fast memory"
          size="icon"
          variant="ghost"
          onClick={() => setMemoryOpen(true)}
        >
          <NotebookPen className="size-4" />
        </Button>
        <Button
          aria-label="Open agent files"
          aria-pressed={filesOpen}
          size="icon"
          variant="ghost"
          disabled={agent.scratchStatus !== "ready" || worker?.online === false}
          onClick={() => setFilesOpen((open) => !open)}
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
      {status ? (
        <p
          role="status"
          className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {status}
        </p>
      ) : null}
      {providerStatus ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <p role="status" className="text-xs text-muted-foreground">
            {providerStatus}
          </p>
          {recoveryActive ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={interrupt.isPending}
              onClick={() =>
                interrupt.mutate(undefined, {
                  onError: (error) =>
                    onToast({
                      title: "Could not stop Council",
                      message: errorMessage(error),
                      tone: "error",
                    }),
                })
              }
            >
              Stop recovery
            </Button>
          ) : null}
        </div>
      ) : null}
      {chat.isError ? (
        <InlineAlert>{errorMessage(chat.error)}</InlineAlert>
      ) : null}
      {chat.isPending ? (
        <p className="p-4 text-sm text-muted-foreground">
          Opening conversation…
        </p>
      ) : null}
      {chat.data ? (
        <ChatTranscript
          capabilities={COUNCIL_CHAT_SURFACE_CAPABILITIES}
          chat={chat.data}
          desktopRuntime={desktopRuntime}
          filesOpen={filesOpen}
          filesRequestedPath={filePath}
          githubEnabled={false}
          inspectOpen={false}
          inspectOverlay={narrowViewport}
          onConfigureModels={onConfigureModels}
          onCreateChat={() => showEditor("new")}
          onDelete={() => undefined}
          onFilesOpenChange={setFilesOpen}
          onForked={() => undefined}
          onInspectOpenChange={() => undefined}
          onOpenFile={openFile}
          onOpenRelocation={() => undefined}
          onRename={() => showEditor(agent)}
          onToast={onToast}
          refocusOnWindowActivation={desktopRuntime}
          relocationJob={null}
          settings={settings}
          syncEnabled={false}
        />
      ) : null}
      {memoryOpen ? (
        <CouncilMemoryEditor
          agentId={agent.id}
          onClose={() => setMemoryOpen(false)}
        />
      ) : null}
      {history?.agentId === agent.id ? (
        <CouncilHistoryDialog
          key={history.messageId ?? "search"}
          agentId={agent.id}
          messageId={history.messageId}
          onClose={closeHistory}
          onOpenFile={openFile}
        />
      ) : null}
      {peerId ? (
        <CouncilPeerDialog
          key={peerId}
          agentId={agent.id}
          peerId={peerId}
          agentTitle={agent.title}
          peerTitle={
            roster.data?.find(({ id }) => id === peerId)?.title ??
            "Council agent"
          }
          onClose={() => {
            const url = new URL(window.location.href);
            if (url.searchParams.has("peerAgent")) {
              url.searchParams.delete("peerAgent");
              url.searchParams.delete("councilAgent");
              window.history.replaceState(window.history.state, "", url);
            }
            closePeer();
          }}
        />
      ) : null}
    </div>
  );
}
