import {
  archivedChatSummarySchema,
  chatSummarySchema,
  executionTargetCatalogSchema,
  projectTabLayoutSummarySchema,
  standaloneChatSummarySchema,
  archivedStandaloneChatSummarySchema,
  type ArchivedChatSummary,
  type ArchivedChatWireSummary,
  type ChatSummary,
  type ChatWireSummary,
  type ExecutionTargetCatalog,
  type ExecutionTargetWireCatalog,
  type ProjectTabLayoutSummary,
  type ProjectTabLayoutWireSummary,
  type StandaloneChatSummary,
  type StandaloneChatWireSummary,
  type ArchivedStandaloneChatSummary,
  type ArchivedStandaloneChatWireSummary,
} from "@cantrip/protocol";
import type { PrivateDisplayLabelOpaque } from "@cantrip/protocol/private-labels";

import type { ClientEncryptionService } from "./client-encryption";
import { clientEncryption } from "./client-encryption";
import { getClientSession } from "./client-session";
import {
  decodePrivateDisplayLabelForClient,
  encodePrivateDisplayLabelForClient,
} from "./private-label-encryption";

export class ChatTitleEncryptionAdapter {
  constructor(
    private readonly options: {
      service?: ClientEncryptionService;
      session?: typeof getClientSession;
    } = {},
  ) {}

  private get service(): ClientEncryptionService {
    return this.options.service ?? clientEncryption;
  }

  private identity() {
    const session = (this.options.session ?? getClientSession)();
    if (!session) {
      throw new Error("An authenticated session is required for chat titles.");
    }
    return { ownerId: session.user.id, serverId: session.serverId };
  }

  protect(rowId: string, title: string): Promise<PrivateDisplayLabelOpaque> {
    return encodePrivateDisplayLabelForClient({
      identity: this.identity(),
      label: title.trim(),
      recordKind: "chat",
      rowId,
      service: this.service,
    });
  }

  protectTabGroup(
    rowId: string,
    title: string,
  ): Promise<PrivateDisplayLabelOpaque> {
    return encodePrivateDisplayLabelForClient({
      identity: this.identity(),
      label: title.trim(),
      recordKind: "tab-group",
      rowId,
      service: this.service,
    });
  }

  async open(chat: ChatWireSummary): Promise<ChatSummary> {
    const { titleProtection, ...publicChat } = chat;
    return chatSummarySchema.parse({
      ...publicChat,
      title: await decodePrivateDisplayLabelForClient({
        identity: this.identity(),
        opaque: titleProtection,
        recordKind: "chat",
        rowId: chat.id,
        service: this.service,
      }),
    });
  }

  async openStandalone(
    chat: StandaloneChatWireSummary,
  ): Promise<StandaloneChatSummary> {
    const { titleProtection, ...publicChat } = chat;
    return standaloneChatSummarySchema.parse({
      ...publicChat,
      title: await decodePrivateDisplayLabelForClient({
        identity: this.identity(),
        opaque: titleProtection,
        recordKind: "chat",
        rowId: chat.id,
        service: this.service,
      }),
    });
  }

  async openArchived(
    chat: ArchivedChatWireSummary,
  ): Promise<ArchivedChatSummary> {
    const { titleProtection, ...publicChat } = chat;
    return archivedChatSummarySchema.parse({
      ...publicChat,
      title: await decodePrivateDisplayLabelForClient({
        identity: this.identity(),
        opaque: titleProtection,
        recordKind: "chat",
        rowId: chat.id,
        service: this.service,
      }),
    });
  }

  async openArchivedStandalone(
    chat: ArchivedStandaloneChatWireSummary,
  ): Promise<ArchivedStandaloneChatSummary> {
    const { titleProtection, ...publicChat } = chat;
    return archivedStandaloneChatSummarySchema.parse({
      ...publicChat,
      title: await decodePrivateDisplayLabelForClient({
        identity: this.identity(),
        opaque: titleProtection,
        recordKind: "chat",
        rowId: chat.id,
        service: this.service,
      }),
    });
  }

  async openExecutionTargetCatalog(
    catalog: ExecutionTargetWireCatalog,
  ): Promise<ExecutionTargetCatalog> {
    return executionTargetCatalogSchema.parse({
      ...catalog,
      targets: await Promise.all(
        catalog.targets.map(async ({ titleProtection, ...target }) => {
          if (target.title !== null) return { ...target, title: target.title };
          if (!titleProtection || target.target.kind !== "surface") {
            throw new Error(
              "A protected execution target must identify a protected surface.",
            );
          }
          return {
            ...target,
            title: await decodePrivateDisplayLabelForClient({
              identity: this.identity(),
              opaque: titleProtection,
              recordKind: titleProtection.classification.recordKind,
              rowId: target.target.surfaceId,
              service: this.service,
            }),
          };
        }),
      ),
    });
  }

  async openTabLayout(
    layout: ProjectTabLayoutWireSummary,
  ): Promise<ProjectTabLayoutSummary> {
    return projectTabLayoutSummarySchema.parse({
      ...layout,
      groups: await Promise.all(
        layout.groups.map(async ({ titleProtection, ...group }) => {
          const members = await Promise.all(
            group.members.map(async ({ titleProtection, ...member }) => ({
              ...member,
              title: titleProtection
                ? await decodePrivateDisplayLabelForClient({
                    identity: this.identity(),
                    opaque: titleProtection,
                    recordKind: titleProtection.classification.recordKind,
                    rowId: member.tabId,
                    service: this.service,
                  })
                : "Run configuration",
            })),
          );
          const anchor = members.find(
            ({ tabKey }) => tabKey === group.anchorTabKey,
          );
          if (!anchor) {
            throw new Error("The tab group anchor is not one of its members.");
          }
          return {
            ...group,
            title: titleProtection
              ? await decodePrivateDisplayLabelForClient({
                  identity: this.identity(),
                  opaque: titleProtection,
                  recordKind: "tab-group",
                  rowId: group.id,
                  service: this.service,
                })
              : anchor.title,
            members,
          };
        }),
      ),
    });
  }
}

export const chatTitleEncryption = new ChatTitleEncryptionAdapter();
