import type { ChatSummary } from "@cantrip/protocol";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { ChatTranscript } from "./chat-transcript";
import { IDE_CHAT_SURFACE_CAPABILITIES } from "./chat-surface-capabilities";
import type { IncomingChatView } from "./chat-view-state";

/** Render a specific tab's resource, never the shell's changing selected chat. */
export function WorkspaceChatPanel({
  chat,
  visible,
  bindings,
  tabId,
  incoming,
}: {
  chat: ChatSummary;
  visible: boolean;
  bindings: Readonly<Record<string, any>>;
  tabId: string;
  incoming?: IncomingChatView;
}) {
  return (
    <>
      <PanelToolbar aria-label="Agent controls">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {chat.title}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {bindings.renderAgentPanelActions?.(chat)}
        </div>
      </PanelToolbar>
      <ChatTranscript
        workspaceTabId={tabId}
        incomingChatView={incoming}
        capabilities={IDE_CHAT_SURFACE_CAPABILITIES}
        chat={chat}
        onConfigureModels={() => bindings.openCompactRootSettings("models")}
        githubEnabled={bindings.selectedProject?.capabilities.github ?? false}
        inspectOnly={chat.experience === "task"}
        inspectOpen={bindings.agentInspectOpenChats?.has(chat.id) ?? false}
        inspectOverlay={bindings.narrowViewport}
        settings={bindings.settings?.data}
        syncEnabled
        onCreateChat={() =>
          bindings.newChat.mutate({ projectId: chat.projectId })
        }
        onDelete={() => {
          bindings.setAgentInspectOpen(chat.id, false);
          bindings.deleteChatMutation.mutate(chat.id);
        }}
        onForked={(forked) => {
          if (forked.contextKind !== "standalone")
            bindings.openCreatedTab(forked.projectId, "chat", forked.id);
        }}
        onInspectOpenChange={(open) =>
          bindings.setAgentInspectOpen(chat.id, open)
        }
        onOpenFile={(reference, worktreeId) =>
          bindings.openChatFileLink(chat, reference, worktreeId)
        }
        onOpenRelocation={() => bindings.setChatRelocationOpen(true)}
        onToast={bindings.showAppToast}
        onRename={(title) =>
          bindings.renameChatMutation.mutate({ chatId: chat.id, title })
        }
        relocationJob={
          bindings.selectedProject?.capabilities.relocation &&
          bindings.selectedChat?.id === chat.id
            ? bindings.currentRelocation
            : null
        }
        refocusOnWindowActivation={visible && bindings.desktopRuntime}
      />
    </>
  );
}
