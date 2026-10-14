import {
  codeTabWireListSchema,
  codeTabWireSummarySchema,
  codeSettingsWorkbenchAttachmentWireSchema,
  codeSettingsWorkbenchAttachmentCreateSchema,
  codeSettingsWorkerStatusSchema,
  codeSettingsResolveRequestSchema,
  codeSettingsSynchronizeRequestSchema,
  codeProtectedAttachmentIntentSchema,
  codeProtectedAttachmentWireSchema,
  codeProtectedAttachmentCreateSchema,
  explorerCodeProtectedAttachmentCreateSchema,
  codeSharedAttachmentWireSchema,
  explorerCodeSessionAttachmentCreateSchema,
  codeRuntimeStatusSchema,
  codeSaveAllResultSchema,
} from "@cantrip/protocol";
import { request, post, BOUND_API_REQUEST_BEHAVIOR } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  isVisibleProjectCodeTab,
  INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
} from "@/lib/code-tab-visibility";
import type {
  ExecutionTarget,
  CodeThemeMode,
  CodeSharedAttachmentWire,
  CodeAppearance,
  CodeSettingsResolution,
} from "@cantrip/protocol";
import {
  type ClientSessionIdentitySnapshot,
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { getActiveServerUrl } from "@/lib/server-connections";
import {
  protectTunnelContentRecord,
  createTunnelDataProtection,
} from "@/lib/tunnel-content-encryption";
import { createBoundedResource } from "@/lib/bounded-resource-creation";
import { ensureTunnelWorker } from "./tunnels";
import { ensureCustomizationWorker } from "./customization";

async function getOpenedCodeTabs(projectId: string) {
  const codeTabs = codeTabWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`),
  );
  return Promise.all(
    codeTabs.map((codeTab) => surfaceTitleEncryption.openCodeTab(codeTab)),
  );
}

export async function getCodeTabs(projectId: string) {
  return (await getOpenedCodeTabs(projectId)).filter((codeTab) =>
    isVisibleProjectCodeTab(codeTab.title),
  );
}

export async function getInternalExplorerEditorCodeTabs(projectId: string) {
  return (await getOpenedCodeTabs(projectId)).filter(
    (codeTab) => codeTab.title === INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
  );
}

export async function createCodeTab(
  projectId: string,
  title = "Code",
  worktreeId?: string,
  paneId?: string,
  target?: ExecutionTarget,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "code-tab",
  );
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`, {
        id,
        titleProtection,
        ...(worktreeId ? { worktreeId } : {}),
        ...(paneId ? { paneId } : {}),
        ...(target ? { target } : {}),
      }),
    ),
  );
}

export async function updateCodeTab(
  codeTabId: string,
  input: { title?: string; themeMode?: CodeThemeMode },
) {
  const titleProtection = input.title
    ? await surfaceTitleEncryption.protect(codeTabId, input.title, "code-tab")
    : undefined;
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(titleProtection ? { titleProtection } : {}),
          ...(input.themeMode ? { themeMode: input.themeMode } : {}),
        }),
      }),
    ),
  );
}

export async function updateCodeTabWorktree(
  codeTabId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await request(
        `/api/code-tabs/${encodeURIComponent(codeTabId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function deleteCodeTab(codeTabId: string) {
  await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
    keepalive: true,
    method: "DELETE",
  });
}

const PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS = 10_000;

const PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS = 5_000;

export interface BoundExplorerCodeSessionAttachment {
  attachment: CodeSharedAttachmentWire;
  binding: {
    identity: ClientSessionIdentitySnapshot;
    serverUrl: string;
  };
}

function captureCodeSessionApiBinding(): BoundExplorerCodeSessionAttachment["binding"] {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) {
    throw new Error("Cantrip Code requires an authenticated client session.");
  }
  const serverUrl = getActiveServerUrl();
  if (identity.serverUrl !== serverUrl) {
    throw new Error(
      "The Cantrip Code server identity changed while it was being captured.",
    );
  }
  return { identity, serverUrl };
}

export function explorerCodeSessionBindingCurrent(
  binding: BoundExplorerCodeSessionAttachment["binding"],
): boolean {
  return (
    getActiveServerUrl() === binding.serverUrl &&
    clientSessionIdentityMatches(binding.identity)
  );
}

export function assertCreatedExplorerCodeSessionIdentity(
  attachment: CodeSharedAttachmentWire,
  expected: {
    attachmentId: string;
    serverId: string;
    sessionId: string;
    workerId: string;
  },
): void {
  if (
    attachment.session.attachmentId !== expected.attachmentId ||
    attachment.session.sessionId !== expected.sessionId ||
    attachment.transport.workerId !== expected.workerId ||
    attachment.transport.serverId !== expected.serverId
  ) {
    throw new Error(
      "The shared Cantrip Code attachment changed logical identity.",
    );
  }
}

function assertExplorerCodeSessionBindingCurrent(
  binding: BoundExplorerCodeSessionAttachment["binding"],
): void {
  if (!explorerCodeSessionBindingCurrent(binding)) {
    throw new Error(
      "The Cantrip Code server or authentication identity changed while connecting.",
    );
  }
}

async function protectedSharedCodeTransportCandidate(input: {
  transportId: string;
  workerId: string;
}) {
  await ensureTunnelWorker(input.workerId);
  return {
    formatVersion: 2 as const,
    transportId: input.transportId,
    protectedRecord: await protectTunnelContentRecord({
      content: {
        name: "Cantrip Code",
        description: "Shared protected editor transport.",
        source: { kind: "desktop-loopback" },
        destination: sharedCodeTransportDestination(input),
        dataProtection: createTunnelDataProtection(),
      },
      operationId: input.transportId,
      revision: 1,
      tunnelId: input.transportId,
      workerId: input.workerId,
    }),
  };
}

export function sharedCodeTransportDestination(input: {
  transportId: string;
  workerId: string;
}) {
  return {
    kind: "worker-code-transport" as const,
    workerId: input.workerId,
    resourceId: input.transportId,
  };
}

async function protectedCodeAttachmentInput(input: {
  appearance: CodeAppearance;
  expectedWorktreeId?: string;
  sessionId: string;
  tunnelId: string;
  workerId: string;
}) {
  await ensureTunnelWorker(input.workerId);
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: "Cantrip Code",
      description: "Protected editor access for this Code surface.",
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-code",
        workerId: input.workerId,
        resourceId: input.tunnelId,
        sessionId: input.sessionId,
      },
      dataProtection: createTunnelDataProtection(),
    },
    operationId: input.tunnelId,
    revision: 1,
    tunnelId: input.tunnelId,
    workerId: input.workerId,
  });
  return {
    appearance: input.appearance,
    expectedWorkerId: input.workerId,
    ...(input.expectedWorktreeId
      ? { expectedWorktreeId: input.expectedWorktreeId }
      : {}),
    protectedRecord,
    sessionId: input.sessionId,
    tunnelId: input.tunnelId,
  };
}

export async function createProtectedCodeSettingsAttachment(
  workerId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      // A fresh worker can register its encryption principal before it has any
      // account component grants. Settings is a global surface, so authorize
      // customization on demand like the other settings flows do.
      await ensureCustomizationWorker(workerId);
      const input = await protectedCodeAttachmentInput({
        appearance,
        sessionId,
        tunnelId,
        workerId,
      });
      return codeSettingsWorkbenchAttachmentWireSchema.parse(
        await request("/api/settings/code/protected-code-attachments", {
          body: JSON.stringify(
            codeSettingsWorkbenchAttachmentCreateSchema.parse(input),
          ),
          method: "POST",
          signal,
        }),
      );
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function getCodeSettingsWorkerStatus(workerId: string) {
  return codeSettingsWorkerStatusSchema.parse(
    await request(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/status`,
    ),
  );
}

export async function resolveCodeSettingsWorker(
  workerId: string,
  resolution: CodeSettingsResolution,
) {
  return codeSettingsWorkerStatusSchema.parse(
    await post(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/resolve`,
      codeSettingsResolveRequestSchema.parse({ resolution }),
    ),
  );
}

export async function synchronizeCodeSettingsWorker(workerId: string) {
  return codeSettingsWorkerStatusSchema.parse(
    await post(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/synchronize`,
      codeSettingsSynchronizeRequestSchema.parse({
        initializeIfMissing: false,
      }),
    ),
  );
}

export async function createProtectedCodeAttachment(
  codeTabId: string,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      const intent = codeProtectedAttachmentIntentSchema.parse(
        await request(
          `/api/code-tabs/${encodeURIComponent(codeTabId)}/protected-attachment-intents`,
          {
            body: JSON.stringify({
              appearance,
              expectedWorkerId: workerId,
              expectedWorktreeId: worktreeId,
            }),
            method: "POST",
            signal,
          },
        ),
      );
      const input = await protectedCodeAttachmentInput({
        appearance,
        expectedWorktreeId: worktreeId,
        sessionId: intent.sessionId,
        tunnelId,
        workerId,
      });
      const wire = codeProtectedAttachmentWireSchema.parse(
        await request(
          `/api/code-tabs/${encodeURIComponent(codeTabId)}/protected-attachments`,
          {
            body: JSON.stringify(
              codeProtectedAttachmentCreateSchema.parse(input),
            ),
            method: "POST",
            signal,
          },
        ),
      );
      if (wire.sessionId !== intent.sessionId) {
        throw new Error("Protected Code attachment changed runtime sessions.");
      }
      return wire;
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function createProtectedExplorerCodeAttachment(
  explorerId: string,
  relativePath: string | null,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      const input = await protectedCodeAttachmentInput({
        appearance,
        expectedWorktreeId: worktreeId,
        sessionId,
        tunnelId,
        workerId,
      });
      return codeProtectedAttachmentWireSchema.parse(
        await request(
          `/api/explorers/${encodeURIComponent(explorerId)}/protected-code-attachments`,
          {
            body: JSON.stringify(
              explorerCodeProtectedAttachmentCreateSchema.parse({
                ...input,
                ...(relativePath ? { path: relativePath } : {}),
              }),
            ),
            method: "POST",
            signal,
          },
        ),
      );
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function createProtectedExplorerCodeSessionAttachment(
  explorerId: string,
  relativePath: string | null,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
): Promise<BoundExplorerCodeSessionAttachment> {
  const binding = captureCodeSessionApiBinding();
  const attachmentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const transportId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      assertExplorerCodeSessionBindingCurrent(binding);
      const transport = await protectedSharedCodeTransportCandidate({
        transportId,
        workerId,
      });
      assertExplorerCodeSessionBindingCurrent(binding);
      const attachment = codeSharedAttachmentWireSchema.parse(
        await request(
          `${binding.serverUrl}/api/explorers/${encodeURIComponent(explorerId)}/code-session-attachments`,
          {
            body: JSON.stringify(
              explorerCodeSessionAttachmentCreateSchema.parse({
                appearance,
                attachmentId,
                expectedWorkerId: workerId,
                expectedWorktreeId: worktreeId,
                formatVersion: 2,
                ...(relativePath ? { path: relativePath } : {}),
                sessionId,
                transport,
              }),
            ),
            method: "POST",
            signal,
          },
          BOUND_API_REQUEST_BEHAVIOR,
        ),
      );
      // The candidate transport id is intentionally not an expected response
      // identity. The server returns the already-active root when another tab
      // wins acquisition for the same security identity.
      assertCreatedExplorerCodeSessionIdentity(attachment, {
        attachmentId,
        serverId: binding.identity.serverId,
        sessionId,
        workerId,
      });
      assertExplorerCodeSessionBindingCurrent(binding);
      return { attachment, binding };
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: attachmentId,
    rollback: (resourceId, signal) =>
      releaseProtectedExplorerCodeSessionAttachmentId(resourceId, binding, {
        signal,
      }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

async function releaseProtectedExplorerCodeSessionAttachmentId(
  attachmentId: string,
  binding: BoundExplorerCodeSessionAttachment["binding"],
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!explorerCodeSessionBindingCurrent(binding)) return;
  await request(
    `${binding.serverUrl}/api/code-session-attachments/${encodeURIComponent(attachmentId)}`,
    {
      keepalive: true,
      method: "DELETE",
      signal:
        options.signal ??
        AbortSignal.timeout(PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS),
    },
    BOUND_API_REQUEST_BEHAVIOR,
  );
}

export async function releaseProtectedExplorerCodeSessionAttachment(
  owned: BoundExplorerCodeSessionAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await releaseProtectedExplorerCodeSessionAttachmentId(
    owned.attachment.session.attachmentId,
    owned.binding,
    options,
  );
}

export function assertRenewedExplorerCodeSessionIdentity(
  previous: CodeSharedAttachmentWire,
  renewed: CodeSharedAttachmentWire,
  bindingServerId: string,
): void {
  if (
    renewed.session.attachmentId !== previous.session.attachmentId ||
    renewed.session.sessionId !== previous.session.sessionId ||
    renewed.session.routeGrant !== previous.session.routeGrant ||
    renewed.session.runtime.sessionIncarnationId !==
      previous.session.runtime.sessionIncarnationId ||
    renewed.transport.transportId !== previous.transport.transportId ||
    renewed.transport.tunnelId !== previous.transport.tunnelId ||
    renewed.transport.workerId !== previous.transport.workerId ||
    renewed.transport.securityScopeId !== previous.transport.securityScopeId ||
    renewed.transport.serverId !== previous.transport.serverId ||
    renewed.transport.serverId !== bindingServerId ||
    renewed.transport.serverControlPlaneGeneration !==
      previous.transport.serverControlPlaneGeneration ||
    renewed.transport.protectedKeyRevision !==
      previous.transport.protectedKeyRevision ||
    renewed.transport.workerProcessGeneration !==
      previous.transport.workerProcessGeneration
  ) {
    throw new Error("The shared Cantrip Code session lease changed identity.");
  }
}

export async function renewProtectedExplorerCodeSessionAttachment(
  owned: BoundExplorerCodeSessionAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<BoundExplorerCodeSessionAttachment> {
  assertExplorerCodeSessionBindingCurrent(owned.binding);
  const attachment = codeSharedAttachmentWireSchema.parse(
    await request(
      `${owned.binding.serverUrl}/api/code-session-attachments/${encodeURIComponent(owned.attachment.session.attachmentId)}/lease`,
      {
        method: "POST",
        signal: options.signal,
      },
      BOUND_API_REQUEST_BEHAVIOR,
    ),
  );
  assertRenewedExplorerCodeSessionIdentity(
    owned.attachment,
    attachment,
    owned.binding.identity.serverId,
  );
  assertExplorerCodeSessionBindingCurrent(owned.binding);
  // The bound object is the local ownership key used by the native lease
  // registry. Refresh it in place so renewal cannot orphan that exact lease
  // behind a structurally equivalent replacement object.
  owned.attachment = attachment;
  return owned;
}

export async function getCodeRuntime(codeTabId: string, sessionId: string) {
  return codeRuntimeStatusSchema.parse(
    await request(
      `/api/code-tabs/${encodeURIComponent(codeTabId)}/sessions/${encodeURIComponent(sessionId)}/runtime`,
    ),
  );
}

export async function releaseCodeAttachment(
  attachmentId: string,
  options: { signal?: AbortSignal } = {},
) {
  await request(`/api/code-attachments/${encodeURIComponent(attachmentId)}`, {
    keepalive: true,
    method: "DELETE",
    signal:
      options.signal ??
      AbortSignal.timeout(PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS),
  });
}

export async function saveAllCodeTab(codeTabId: string) {
  return codeSaveAllResultSchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/save-all`, {}),
  );
}

export async function stopCodeTab(codeTabId: string) {
  const result = await post(
    `/api/code-tabs/${encodeURIComponent(codeTabId)}/stop`,
    {},
  );
  return result === null ? null : codeRuntimeStatusSchema.parse(result);
}

export async function setCodeTabTheme(
  codeTabId: string,
  themeMode: CodeThemeMode,
  appearance: CodeAppearance,
) {
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/theme`, {
        themeMode,
        appearance,
      }),
    ),
  );
}
