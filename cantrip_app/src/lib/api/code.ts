import {
  codeTabWireListSchema,
  codeTabWireSummarySchema,
  type ExecutionTarget,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import { isVisibleProjectCodeTab } from "@/lib/code-tab-visibility";

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
  input: { title?: string },
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
