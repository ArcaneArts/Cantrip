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
import { createCodeTab as qaCreateCode } from '@/lib/api/code';
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
async function qaLegacyNativeWindow(withLaunchId) {
  if (!qaProjectId) await globalThis.__qaRepositoryFixture.create();
  const explorer = await qaCreateExplorer(qaProjectId, 'Native legacy import QA', undefined, undefined, undefined, {
    attachToTabLayout: false, initialViewState: { selectedPath: 'qa.txt', fileMode: 'edit' },
  });
  const identity = qaIdentity();
  const scope = await qaWorkspaceIdentity(identity, qaProjectId);
  const windowId = 'cantrip-editor-qa-' + crypto.randomUUID();
  const store = new QaDocumentStore();
  store.resetScope(JSON.stringify([identity.serverId, identity.userId]));
  for (const filePath of ['qa.txt', 'second.txt']) {
    const file = await qaReadFile(explorer.id, filePath);
    store.open(qaDocumentId({server:identity.serverId, account:identity.userId, worker:explorer.activeWorkerId,
      project:qaProjectId, worktree:explorer.worktreeId, path:filePath}), file.content, file.version).editExternal('Imported dirty ' + filePath + '\\n');
  }
  const recovery = new QaRecovery({serverId:identity.serverId, ownerId:identity.userId, workspaceId:scope.workspaceId,
    projectId:qaProjectId, workerId:explorer.activeWorkerId, worktreeId:explorer.worktreeId,
    tabId:windowId, documentId:'legacy-window:'+explorer.id});
  const bytes = new TextEncoder().encode(JSON.stringify({request:null, capture:{explorerId:explorer.id,
    projectId:qaProjectId,workerId:explorer.activeWorkerId,worktreeId:explorer.worktreeId,selectedPath:'qa.txt',fileMode:'edit',documents:store.captureRecovery()}}));
  try { await recovery.load(bytes=>JSON.parse(new TextDecoder().decode(bytes))); await recovery.checkpoint(bytes); }
  finally { bytes.fill(0); recovery.dispose(); }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const search = qaFileSearch({explorerId:explorer.id, projectId:qaProjectId, path:'qa.txt'}, withLaunchId ? crypto.randomUUID() : undefined);
  new WebviewWindow(windowId, {url:'/' + search, title:'Legacy import QA', width:900, height:700});
}
if (import.meta.env.VITE_CANTRIP_LEGACY_WINDOW_QA === 'true') {
  const controls = document.createElement('div');
  controls.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#222;color:white;padding:8px';
  for (const [title, withLaunchId] of [['QA legacy window', false], ['QA legacy launch link', true]]) {
    const button = document.createElement('button'); button.textContent = title; button.style.marginRight = '12px';
    button.onclick = () => { button.disabled = true; void qaLegacyNativeWindow(withLaunchId).catch(error => {
      controls.append(document.createTextNode(String(error)));
    }).finally(() => {button.disabled = false;}); };
    controls.append(button);
  }
  void import('@tauri-apps/api/window').then(({getCurrentWindow}) => {if (getCurrentWindow().label === 'main') document.body.append(controls);});
}
async function qaWorkspace() {
  const identity = qaIdentity();
  const scope = await qaWorkspaceIdentity(identity, qaProjectId);
  const transport = qaWorkspaceTransport(qaProjectId, scope.workspaceId, identity);
  return { scope, transport, layout: await transport.read() };
}
if (import.meta.env.VITE_CANTRIP_CODE_MIGRATION_QA === 'true') {
  const button = document.createElement('button');
  button.textContent = 'QA restore Code drafts';
  button.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#222;color:white;padding:8px';
  button.onclick = () => { button.disabled = true;
    if (!qaProjectId) {
      void globalThis.__qaRepositoryFixture.create().then(() => {button.textContent = 'Open Editor-Recovery-QA, then click to restore Code';})
        .catch(error => {button.textContent = String(error);}).finally(() => {button.disabled = false;});
      return;
    }
    void globalThis.__qaRepositoryFixture.seedLegacyFile('second.txt', {
    'qa.txt':'Code dirty qa.txt\\n', 'second.txt':'Code dirty second.txt\\n',
  }, 'code').then(() => {button.textContent = 'Code drafts seeded';}).catch(error => {button.textContent = String(error);}).finally(() => {button.disabled = false;}); };
  void import('@tauri-apps/api/window').then(({getCurrentWindow}) => {if (getCurrentWindow().label === 'main') document.body.append(button);});
}
globalThis.__qaRepositoryFixture = {
  async workspace() { return qaIdentity() ? (await qaWorkspace()).layout : null; },
  async seedLegacyFile(path = 'qa.txt', drafts = {}, sourceKind = 'explorer') {
    const reader = await qaCreateExplorer(qaProjectId, 'Legacy migration QA', undefined, undefined, undefined, {
      attachToTabLayout: false, initialViewState: { selectedPath: path, fileMode: 'edit' },
    });
    const explorer = sourceKind === 'code' ? await qaCreateCode(qaProjectId, 'Code migration QA', reader.worktreeId) : reader;
    const { scope, transport, layout } = await qaWorkspace();
    const owner = layout.windows.find(window => window.id === scope.mainWindowId);
    const tabId = crypto.randomUUID();
    if (Object.keys(drafts).length) {
      const identity = qaIdentity();
      const store = new QaDocumentStore();
      store.resetScope(JSON.stringify([identity.serverId, identity.userId]));
      for (const [filePath, text] of Object.entries(drafts)) {
        const file = await qaReadFile(reader.id, filePath);
        store.open(qaDocumentId({server:identity.serverId, account:identity.userId,
          worker:explorer.activeWorkerId, project:qaProjectId, worktree:explorer.worktreeId, path:filePath}),
          file.content, file.version).editExternal(text);
      }
      const recovery = new QaRecovery({serverId:identity.serverId, ownerId:identity.userId,
        workspaceId:layout.id, projectId:qaProjectId, workerId:explorer.activeWorkerId,
        worktreeId:explorer.worktreeId, tabId, documentId:(sourceKind === 'code' ? 'legacy-code-migration:' : 'legacy-migration:')+explorer.id});
      const bytes = new TextEncoder().encode(JSON.stringify({explorerId:explorer.id,projectId:qaProjectId,
        workerId:explorer.activeWorkerId,worktreeId:explorer.worktreeId,selectedPath:path,fileMode:'edit',
        documents:store.captureRecovery()}));
      try { await recovery.load(bytes=>JSON.parse(new TextDecoder().decode(bytes))); await recovery.checkpoint(bytes); }
      finally { bytes.fill(0); recovery.dispose(); }
    }
    await transport.execute({ operationId: crypto.randomUUID(), workspaceId: layout.id, projectId: qaProjectId,
      windowId: owner.id, attachmentGeneration: owner.attachmentGeneration, expectedRevision: layout.revision,
      action: { type: 'open', tab: { id: tabId, resource: { kind: 'entity', definitionId: sourceKind === 'code' ? 'project.code' : 'project.explorer', resourceId: explorer.id },
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
