import {
  tunnelWireListSchema,
  type ProjectSummary,
  projectShareAttachmentWireSchema,
  projectShareTunnelCreateSchema,
  projectShareAttachmentSchema,
  type StandaloneChatSummary,
  standaloneChatShareAttachmentWireSchema,
  standaloneChatShareAttachmentSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import {
  openTunnelContentRecord,
  protectTunnelContentRecord,
  createTunnelDataProtection,
} from "@/lib/tunnel-content-encryption";
import {
  randomBytes,
  encodeBase64Url,
  clearSensitiveBytes,
} from "@cantrip/crypto";
import { recoverStaleProjectShareState } from "@/lib/project-share-recovery";
import { ensureTunnelWorker } from "./tunnels";

async function currentProjectNetworkShare(projectId: string) {
  return tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ origin, projectId: candidateProjectId }) =>
        origin === "project-share" && candidateProjectId === projectId,
    );
}

type ProjectNetworkShareTarget = Pick<
  ProjectWorktreeSummary,
  "id" | "path" | "workerId"
>;

async function createProjectNetworkShareAttempt(
  project: ProjectSummary,
  target?: ProjectNetworkShareTarget,
) {
  const source = target ?? project.source;
  if (!source) throw new Error("Project source is unavailable.");
  let existing = await currentProjectNetworkShare(project.id);
  if (existing && !existing.protectedRecord) {
    await deleteProjectNetworkShare(existing.id);
    existing = undefined;
  }
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  const tokenBytes = randomBytes(32);
  const usernameBytes = randomBytes(18);
  const passwordBytes = randomBytes(32);
  try {
    const publicBasePath = `/project-shares/${encodeBase64Url(tokenBytes)}`;
    const username = `cantrip-${encodeBase64Url(usernameBytes)}`;
    const password = encodeBase64Url(passwordBytes);
    const protectedRecord = await protectTunnelContentRecord({
      content: {
        name: "Project files",
        description: "Secure WebDAV access to this project's files.",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-project-share",
          workerId: source.workerId,
          resourceId: tunnelId,
          root: source.path,
          publicBasePath,
          publicOrigin: "http://127.0.0.1",
          username,
          password,
          realm: "Cantrip Project Share",
        },
        dataProtection:
          existingContent?.dataProtection ?? createTunnelDataProtection(),
      },
      operationId: existing ? crypto.randomUUID() : tunnelId,
      revision: (existing?.protectedRecord?.revision ?? 0) + 1,
      tunnelId,
      workerId: source.workerId,
    });
    const wire = projectShareAttachmentWireSchema.parse(
      await post(
        `/api/projects/${encodeURIComponent(project.id)}/network-shares`,
        projectShareTunnelCreateSchema.parse({
          tunnelId,
          workerId: source.workerId,
          ...(target ? { worktreeId: target.id } : {}),
          protectedRecord,
        }),
      ),
    );
    if (wire.tunnelId !== tunnelId || wire.projectId !== project.id) {
      throw new Error("Project share response belongs to another tunnel.");
    }
    return projectShareAttachmentSchema.parse({
      attachmentId: wire.attachmentId,
      projectId: wire.projectId,
      protocol: wire.protocol,
      url: `http://127.0.0.1${publicBasePath}/`,
      username,
      password,
      realm: "Cantrip Project Share",
      expiresAt: wire.expiresAt,
      mountLeaseMs: wire.mountLeaseMs,
    });
  } finally {
    clearSensitiveBytes(tokenBytes);
    clearSensitiveBytes(usernameBytes);
    clearSensitiveBytes(passwordBytes);
  }
}

export async function createProjectNetworkShare(
  project: ProjectSummary,
  target?: ProjectNetworkShareTarget,
) {
  const source = target ?? project.source;
  if (!source) throw new Error("Project source is unavailable.");
  await ensureTunnelWorker(source.workerId);
  return recoverStaleProjectShareState({
    open: () => createProjectNetworkShareAttempt(project, target),
    revokeOrphan: async () => {
      const orphan = await currentProjectNetworkShare(project.id);
      if (orphan) await deleteProjectNetworkShare(orphan.id);
    },
  });
}

export async function createStandaloneChatNetworkShare(
  chat: StandaloneChatSummary,
) {
  const workerId = chat.activeWorkerId;
  const rootId = chat.activeScratchRootId;
  if (!workerId || !rootId) {
    throw new Error("Chat scratch placement is unavailable.");
  }
  await ensureTunnelWorker(workerId);
  const managedResourceId = `chat:${chat.id}`;
  let existing = tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ origin, managedBy }) =>
        origin === "project-share" &&
        managedBy?.kind === "project-share" &&
        managedBy.id === managedResourceId,
    );
  let existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId: existing.id,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  if (
    existing &&
    (!existingContent ||
      existingContent.destination.kind !== "worker-chat-share" ||
      existingContent.destination.chatId !== chat.id ||
      existingContent.destination.rootId !== rootId ||
      existingContent.destination.workerId !== workerId)
  ) {
    await deleteProjectNetworkShare(existing.id);
    existing = undefined;
    existingContent = null;
  }
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const tokenBytes = randomBytes(32);
  const usernameBytes = randomBytes(18);
  const passwordBytes = randomBytes(32);
  try {
    const publicBasePath = `/project-shares/${encodeBase64Url(tokenBytes)}`;
    const username = `cantrip-${encodeBase64Url(usernameBytes)}`;
    const password = encodeBase64Url(passwordBytes);
    const protectedRecord = await protectTunnelContentRecord({
      content: {
        name: "Chat scratch files",
        description: "Secure WebDAV access to this Chat's scratch files.",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-chat-share",
          workerId,
          resourceId: tunnelId,
          chatId: chat.id,
          rootId,
          publicBasePath,
          publicOrigin: "http://127.0.0.1",
          username,
          password,
          realm: "Cantrip Chat Share",
        },
        dataProtection:
          existingContent?.dataProtection ?? createTunnelDataProtection(),
      },
      operationId: existing ? crypto.randomUUID() : tunnelId,
      revision: (existing?.protectedRecord?.revision ?? 0) + 1,
      tunnelId,
      workerId,
    });
    const wire = standaloneChatShareAttachmentWireSchema.parse(
      await post(
        `/api/chats/${encodeURIComponent(chat.id)}/network-shares`,
        projectShareTunnelCreateSchema.parse({
          tunnelId,
          workerId,
          protectedRecord,
        }),
      ),
    );
    if (wire.tunnelId !== tunnelId || wire.chatId !== chat.id) {
      throw new Error("Chat share response belongs to another tunnel.");
    }
    return standaloneChatShareAttachmentSchema.parse({
      attachmentId: wire.attachmentId,
      chatId: wire.chatId,
      protocol: wire.protocol,
      url: `http://127.0.0.1${publicBasePath}/`,
      username,
      password,
      realm: "Cantrip Chat Share",
      expiresAt: wire.expiresAt,
      mountLeaseMs: wire.mountLeaseMs,
    });
  } finally {
    clearSensitiveBytes(tokenBytes);
    clearSensitiveBytes(usernameBytes);
    clearSensitiveBytes(passwordBytes);
  }
}

export async function deleteProjectNetworkShare(attachmentId: string) {
  await request(`/api/project-shares/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}
