import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { transformChatHistoryFixture } from "./workspace-chat-history-fixture.mjs";

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
      const history = transformChatHistoryFixture(source, id);
      if (history) return history;
      if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
        return null;
      return {
        code: `${source}\nimport { createGithubProject as qaCreateProject, getProjects as qaGetProjects } from '@/lib/project-encryption';
import { createProjectWorktree as qaCreateWorktree, getProjectWorktrees as qaGetWorktrees, removeProjectWorktree as qaRemoveWorktree } from '@/lib/api/worktrees';
import { getExplorers as qaGetExplorers, createExplorer as qaCreateExplorer } from '@/lib/api/explorers';
import { createCodeTab as qaCreateCode } from '@/lib/api/code';
import { createFileDocument as qaCreateDocument } from '@/lib/api/file-documents';
import { surfaceTitleEncryption as qaTitles } from '@/lib/surface-title-encryption';
import { bindLegacyDocument as qaBindDocument, planLegacyDocuments as qaPlanDocuments } from '@/components/explorer/legacy-document-migration';
import { createDesktopExplorerWindowBroker as qaCreateFileBroker } from '@/lib/desktop-explorer-window-broker';
import { desktopExplorerFileSearch as qaFileSearch, desktopStandaloneChatFileSearch as qaChatFileSearch } from '@/lib/desktop-popout';
import { createStandaloneChat as qaCreateChat } from '@/lib/api/chats';
import { createChat as qaCreateProjectChat } from '@/lib/api/chats';
import { prepareConversationCreation as qaPrepareConversation, archiveAgentConversation as qaArchiveConversation, recordConversationUsage as qaUseConversation } from '@/lib/api/conversations';
import { desktopQuitCoordinator as qaQuit } from '@/lib/desktop-quit-coordinator';
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
if (import.meta.env.VITE_CANTRIP_QUIT_QA === 'true') {
  void Promise.all([import('@/lib/desktop-quit-coordinator'), import('@tauri-apps/api/window')]).then(([{desktopQuitCoordinator}, {getCurrentWindow}]) => {
    if (getCurrentWindow().label !== 'main') return;
    let fail = true;
    const button = document.createElement('button');
    button.textContent = 'QA quit checkpoint: fail';
    button.style.cssText = 'position:fixed;bottom:52px;left:8px;z-index:2147483647;background:#222;color:white;padding:8px';
    button.onclick = () => { fail = !fail; button.textContent = fail ? 'QA quit checkpoint: fail' : 'QA quit checkpoint: delay 5s'; };
    desktopQuitCoordinator.register({suspend: () => () => {}, checkpoint: async () => {
      console.log('QA_EVT ' + JSON.stringify({event:'quit.checkpoint.started',status:'info',fail}));
      if (fail) throw new Error('Disposable QA checkpoint failure');
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log('QA_EVT ' + JSON.stringify({event:'quit.checkpoint.completed',status:'pass'}));
    }});
    document.body.append(button);
  });
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
  }, 'code', import.meta.env.VITE_CANTRIP_DRAFT_CONFLICT_QA === 'true' ? {'second.txt':'Alternative recovered second.txt\\n'} : {}).then(() => {button.textContent = 'Code drafts seeded';}).catch(error => {button.textContent = String(error);}).finally(() => {button.disabled = false;}); };
  void import('@tauri-apps/api/window').then(({getCurrentWindow}) => {if (getCurrentWindow().label === 'main') document.body.append(button);});
}
globalThis.__qaRepositoryFixture = {
  prepareQuit(id) { return qaQuit.prepare(id); },
  cancelQuit(id) { qaQuit.cancel(id); },
  async useConversation(id) { return qaUseConversation(id, {clientId: crypto.randomUUID(), operationId: crypto.randomUUID(), sequence: 1}); },
  async seedConversations(active, archived) {
    const result = {active: [], archived: []};
    // Real resource creation and encryption, with bounded concurrency.
    const jobs = Array.from({length: active + archived}, (_, index) => index);
    await Promise.all(Array.from({length: 4}, async () => {
      for (;;) {
        const index = jobs.shift();
        if (index === undefined) return;
        const state = index < active ? 'active' : 'archived';
        const create = await qaPrepareConversation(qaProjectId, 'Scale ' + state + ' ' + crypto.randomUUID(), false);
        let chat;
        const deadline = Date.now() + 30_000;
        for (;;) {
          try { chat = await create(); break; }
          catch (error) {
            if (Date.now() >= deadline || !String(error).includes('No online worker has a compatible chat placement')) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
        if (state === 'archived') await qaArchiveConversation(chat.id);
        result[state].push(chat.id);
      }
    }));
    return result;
  },
  async workspace() { return qaIdentity() ? (await qaWorkspace()).layout : null; },
  async seedFileLinkChat(historical = null) {
    const chat = await qaCreateProjectChat(qaProjectId, 'File link QA');
    sessionStorage.setItem('__qaChatFileHistory', JSON.stringify({
      chatId: chat.id, messageId: crypto.randomUUID(), worktreeId: historical?.id ?? chat.activeWorktreeId,
      text: historical
        ? '[Historical relative file](entry/command-first.rs) and [Historical absolute file](' + historical.path + '/entry/command-first.rs:1).'
        : '[Relative QA file](chat-relative.rs) and [Absolute QA file](' + ${JSON.stringify(seed.repository)} + '/chat-absolute.rs:1).',
    }));
    const { scope, transport, layout } = await qaWorkspace();
    const owner = layout.windows.find(window => window.id === scope.mainWindowId);
    const tabId = crypto.randomUUID();
    await transport.execute({operationId:crypto.randomUUID(),workspaceId:layout.id,projectId:qaProjectId,
      windowId:owner.id,attachmentGeneration:owner.attachmentGeneration,expectedRevision:layout.revision,
      action:{type:'open',tab:{id:tabId,resource:{kind:'entity',definitionId:'project.agent',resourceId:chat.id},
        preview:false,titleProtection:null,builtInState:null,dockPresentation:null},
        target:{kind:'new-pane',paneId:crypto.randomUUID(),region:'center',splitId:crypto.randomUUID()}},
    });
    return {chatId:chat.id,tabId};
  },
  async seedLegacyFile(path = 'qa.txt', drafts = {}, sourceKind = 'explorer', targetDrafts = {}) {
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
      const sourceScope = {serverId:identity.serverId,ownerId:identity.userId,explorerId:explorer.id,
        projectId:qaProjectId,workerId:explorer.activeWorkerId,worktreeId:explorer.worktreeId};
      const capture = {...sourceScope,selectedPath:path,fileMode:'edit',documents:store.captureRecovery()};
      for (const candidate of qaPlanDocuments(capture, sourceScope)) {
        if (!(candidate.path in targetDrafts)) continue;
        const binding = {projectId:qaProjectId,workerId:candidate.workerId,worktreeId:candidate.worktreeId,path:candidate.path};
        const document = await qaCreateDocument({...binding,id:qaTitles.fileDocumentId(binding)});
        const fileTabId = 'legacy-code:' + tabId + ':' + document.id;
        const transfer = qaBindDocument(candidate, sourceScope, {tabId:fileTabId,documentId:document.id});
        transfer.documents.documents[0].text = targetDrafts[candidate.path];
        const target = new QaRecovery({...sourceScope,workspaceId:layout.id,tabId:fileTabId,documentId:document.id});
        const data = new TextEncoder().encode(JSON.stringify(transfer));
        try { await target.load(bytes=>JSON.parse(new TextDecoder().decode(bytes))); await target.checkpoint(data); }
        finally {data.fill(0);target.dispose();}
      }
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
  async removeWorktree(id) { return qaRemoveWorktree(qaProjectId, id, {allowExternal:false,force:false}); },
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
