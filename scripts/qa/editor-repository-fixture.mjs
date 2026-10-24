import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A disposable existing checkout, admitted by the normal direct-placement job. */
export async function seedEditorRepository(directory, workerId) {
  const repository = path.join(directory, "repository");
  const name = "Editor-Recovery-QA";
  const nameWithOwner = `Cantrip-QA/${name}`;
  const url = `https://github.com/${nameWithOwner}.git`;
  await mkdir(repository, { recursive: true });
  await writeFile(
    path.join(repository, "qa.txt"),
    "Cantrip editor recovery baseline\n",
  );
  await writeFile(
    path.join(repository, "second.txt"),
    "Cantrip second preview file\n",
  );
  await writeFile(
    path.join(repository, "unknown.cantrip-source"),
    "\uFEFFfirst\r\nsecond\r\n",
  );
  const git = (...args) => exec("git", ["-C", repository, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Cantrip QA");
  await git("config", "user.email", "qa@cantrip.invalid");
  await git("add", "qa.txt", "second.txt", "unknown.cantrip-source");
  await git("commit", "-m", "Initialize disposable worktree fixture");
  // Direct attachment validates the configured identity locally. Nothing is
  // created at this synthetic remote and the fixture never pushes to it.
  await git("remote", "add", "origin", url);
  return {
    name,
    repository,
    input: {
      workerId,
      repositoryId: `qa-${path.basename(directory)}`,
      nameWithOwner,
      url,
      placement: { mode: "direct", path: repository },
    },
  };
}

/** Expose actual client operations only in this fixture's compiled app. */
export function editorRepositoryFixturePlugin(seed) {
  return {
    name: "cantrip-qa-repository-seed",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
        return null;
      return {
        code: `${source}\nimport { createGithubProject as qaCreateProject, getProjects as qaGetProjects } from '@/lib/project-encryption';
import { createProjectWorktree as qaCreateWorktree, getProjectWorktrees as qaGetWorktrees } from '@/lib/api/worktrees';
import { getExplorers as qaGetExplorers, createExplorer as qaCreateExplorer } from '@/lib/api/explorers';
import { createDesktopExplorerWindowBroker as qaCreateFileBroker } from '@/lib/desktop-explorer-window-broker';
import { desktopExplorerFileSearch as qaFileSearch, desktopStandaloneChatFileSearch as qaChatFileSearch } from '@/lib/desktop-popout';
import { createStandaloneChat as qaCreateChat } from '@/lib/api/chats';
import { clearClientSession as qaClearSession } from '@/lib/client-session';
import { getClientSessionIdentitySnapshot as qaIdentity } from '@/lib/client-session';
import { readWorkspaceDeviceIdentity as qaWorkspaceIdentity } from '@/lib/workspace-device-identity';
import { workspaceLayoutTransport as qaWorkspaceTransport } from '@/lib/api/workspace-layouts';
import { getExplorerFile as qaReadFile } from '@/lib/api/files';
import { EditorSessionStore as QaDocumentStore, editorDocumentId as qaDocumentId } from '@/components/editor/document-session';
import { DocumentRecoverySession as QaRecovery } from '@/lib/document-recovery-session';
const qaFileBrokers = new Set();
let qaProjectId = sessionStorage.getItem("__qaRepositoryProjectId");
async function qaWorkspace() {
  const identity = qaIdentity();
  const scope = await qaWorkspaceIdentity(identity, qaProjectId);
  const transport = qaWorkspaceTransport(qaProjectId, scope.workspaceId, identity);
  return { scope, transport, layout: await transport.read() };
}
globalThis.__qaRepositoryFixture = {
  async workspace() { return qaIdentity() ? (await qaWorkspace()).layout : null; },
  async seedLegacyFile(path = 'qa.txt', drafts = {}) {
    const explorer = await qaCreateExplorer(qaProjectId, 'Legacy migration QA', undefined, undefined, undefined, {
      attachToTabLayout: false, initialViewState: { selectedPath: path, fileMode: 'edit' },
    });
    const { scope, transport, layout } = await qaWorkspace();
    const owner = layout.windows.find(window => window.id === scope.mainWindowId);
    const tabId = crypto.randomUUID();
    if (Object.keys(drafts).length) {
      const identity = qaIdentity();
      const store = new QaDocumentStore();
      store.resetScope(JSON.stringify([identity.serverId, identity.userId]));
      for (const [filePath, text] of Object.entries(drafts)) {
        const file = await qaReadFile(explorer.id, filePath);
        store.open(qaDocumentId({server:identity.serverId, account:identity.userId,
          worker:explorer.activeWorkerId, project:qaProjectId, worktree:explorer.worktreeId, path:filePath}),
          file.content, file.version).editExternal(text);
      }
      const recovery = new QaRecovery({serverId:identity.serverId, ownerId:identity.userId,
        workspaceId:layout.id, projectId:qaProjectId, workerId:explorer.activeWorkerId,
        worktreeId:explorer.worktreeId, tabId, documentId:'legacy-migration:'+explorer.id});
      const bytes = new TextEncoder().encode(JSON.stringify({explorerId:explorer.id,projectId:qaProjectId,
        workerId:explorer.activeWorkerId,worktreeId:explorer.worktreeId,selectedPath:path,fileMode:'edit',
        documents:store.captureRecovery()}));
      try { await recovery.load(bytes=>JSON.parse(new TextDecoder().decode(bytes))); await recovery.checkpoint(bytes); }
      finally { bytes.fill(0); recovery.dispose(); }
    }
    await transport.execute({ operationId: crypto.randomUUID(), workspaceId: layout.id, projectId: qaProjectId,
      windowId: owner.id, attachmentGeneration: owner.attachmentGeneration, expectedRevision: layout.revision,
      action: { type: 'open', tab: { id: tabId, resource: { kind: 'entity', definitionId: 'project.explorer', resourceId: explorer.id },
        preview: false, titleProtection: null, builtInState: null, dockPresentation: null },
        target: { kind: 'new-pane', paneId: crypto.randomUUID(), region: 'center', splitId: crypto.randomUUID() } },
    });
    return { tabId, explorerId: explorer.id };
  },
  async create() { const project = await qaCreateProject(${JSON.stringify(seed.input)}); qaProjectId = project.id; sessionStorage.setItem("__qaRepositoryProjectId", project.id); return project; },
  async project() { return (await qaGetProjects()).find(project => project.id === qaProjectId); },
  async worktrees() { return qaGetWorktrees(qaProjectId); },
  async createWorktree(input) { return qaCreateWorktree(qaProjectId, input); },
  async createChat() { return qaCreateChat('Native editor QA Chat'); },
  chatFileSearch(chatId, path) { return qaChatFileSearch({ chatId, path }); },
  revokeOwner() { qaClearSession(); },
  async popout(path, worktreeId) {
    const explorer = worktreeId
      ? await qaCreateExplorer(qaProjectId, 'Native editor worktree QA', worktreeId, undefined, undefined, { attachToTabLayout: false })
      : (await qaGetExplorers(qaProjectId))[0];
    const broker = qaCreateFileBroker({ appearance: 'dark', explorer, path });
    qaFileBrokers.add(broker);
    return qaFileSearch({ explorerId: explorer.id, projectId: qaProjectId, path }, broker.launchId);
  },
  async closePopouts() { await Promise.all([...qaFileBrokers].map(broker => broker.dispose())); qaFileBrokers.clear(); },
};\n`,
        map: null,
      };
    },
  };
}
