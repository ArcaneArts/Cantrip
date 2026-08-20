import {
  archivedChatSummarySchema,
  chatSummarySchema,
  executionTargetCatalogSchema,
  projectTabLayoutSummarySchema,
  type ArchivedChatSummary,
  type ArchivedChatWireSummary,
  type ChatSummary,
  type ChatWireSummary,
  type ExecutionTargetCatalog,
  type ExecutionTargetWireCatalog,
  type ProjectTabLayoutSummary,
  type ProjectTabLayoutWireSummary,
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

  async openExecutionTargetCatalog(
    catalog: ExecutionTargetWireCatalog,
  ): Promise<ExecutionTargetCatalog> {
    return executionTargetCatalogSchema.parse({
      ...catalog,
      targets: await Promise.all(
        catalog.targets.map(async ({ titleProtection, ...target }) => ({
          ...target,
          title:
            target.title ??
            (await decodePrivateDisplayLabelForClient({
              identity: this.identity(),
              opaque: titleProtection,
              recordKind: "chat",
              rowId:
                target.target.kind === "surface"
                  ? target.target.surfaceId
                  : (() => {
                      throw new Error(
                        "A protected chat execution target must identify a surface.",
                      );
                    })(),
              service: this.service,
            })),
        })),
      ),
    });
  }

  async openTabLayout(
    layout: ProjectTabLayoutWireSummary,
  ): Promise<ProjectTabLayoutSummary> {
    return projectTabLayoutSummarySchema.parse({
      ...layout,
      groups: await Promise.all(
        layout.groups.map(async (group) => {
          const members = await Promise.all(
            group.members.map(async ({ titleProtection, ...member }) => ({
              ...member,
              title:
                member.title ??
                (await decodePrivateDisplayLabelForClient({
                  identity: this.identity(),
                  opaque: titleProtection,
                  recordKind: "chat",
                  rowId: member.tabId,
                  service: this.service,
                })),
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
            title: group.title ?? anchor.title,
            members,
          };
        }),
      ),
    });
  }
}

export const chatTitleEncryption = new ChatTitleEncryptionAdapter();
