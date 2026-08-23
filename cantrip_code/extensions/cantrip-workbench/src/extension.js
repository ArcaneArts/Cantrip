"use strict";

const vscode = require("vscode");

const {
  parseRequest,
  reconnectDelayMs,
  safeRelativePaths,
  themeNameForAppearance,
} = require("./protocol.js");
const { forceColorTheme } = require("./theme.js");
const { WorkspaceFileNavigator } = require("./navigation.js");
const {
  configureWorkbenchPresentation,
  setWorkbenchPresentation,
} = require("./layout.js");
const { observeSocketErrors } = require("./socket.js");

function configuration() {
  return vscode.workspace.getConfiguration("cantrip");
}

function bridgeConfiguration() {
  return {
    token: configuration().get("bridgeToken", ""),
    url: configuration().get("bridgeUrl", ""),
  };
}

function identity() {
  const config = configuration();
  return {
    workerId: config.get("workerId", "unknown-worker"),
    workerName: config.get("workerName", "Cantrip Worker"),
    projectId: config.get("projectId", "unknown-project"),
    projectName:
      config.get("projectName", "") ||
      vscode.workspace.name ||
      "Cantrip project",
    sessionId: config.get("sessionId", "unknown-session"),
    worktreeId: config.get("worktreeId", "unknown-worktree"),
    worktreeName: config.get("worktreeName", "") || "worktree",
  };
}

function relativePath(uri) {
  if (uri.scheme === "untitled") return null;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return null;
  return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

function dirtyEditors() {
  const documents = [
    ...vscode.workspace.textDocuments,
    ...(vscode.workspace.notebookDocuments ?? []),
  ];
  const seen = new Set();
  return documents.flatMap((document) => {
    if (!document.isDirty) return [];
    const uri = document.uri.toString();
    if (seen.has(uri)) return [];
    seen.add(uri);
    return [
      {
        uri,
        relativePath: relativePath(document.uri),
        untitled: document.uri.scheme === "untitled",
        dirty: true,
      },
    ];
  });
}

function activeEditorState() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const selection = editor.selection;
  return {
    uri: editor.document.uri.toString(),
    relativePath: relativePath(editor.document.uri),
    selection: {
      startLine: selection.start.line,
      startCharacter: selection.start.character,
      endLine: selection.end.line,
      endCharacter: selection.end.character,
    },
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function bridgeEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid bridge URL]";
  }
}

function bridgeLog(level, event, details = {}) {
  const method = console[level] ?? console.log;
  method.call(
    console,
    `[Cantrip Code bridge] ${event}`,
    JSON.stringify(details),
  );
}

async function saveDirtyEditors() {
  const saved = [];
  const failed = [];
  const documents = [
    ...vscode.workspace.textDocuments,
    ...(vscode.workspace.notebookDocuments ?? []),
  ];
  const seen = new Set();
  for (const document of documents) {
    if (!document.isDirty) continue;
    const uri = document.uri.toString();
    if (seen.has(uri)) continue;
    seen.add(uri);
    if (document.uri.scheme === "untitled") {
      failed.push({
        uri,
        message: "Untitled editors need a file name before an agent can run.",
      });
      continue;
    }
    try {
      if (await document.save()) saved.push(uri);
      else failed.push({ uri, message: "The editor declined to save." });
    } catch (error) {
      failed.push({ uri, message: errorText(error) });
    }
  }
  return { saved, failed };
}

class WorkbenchCoordinator {
  constructor(context) {
    this.context = context;
    this.socket = null;
    this.cancelled = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stateTimer = null;
    this.agentStatus = "idle";
    this.conflicts = [];
    this.git = null;
    this.gitDisposables = [];
    this.gitRepositoryDisposables = [];
    this.disposables = [];
    this.fileNavigator = new WorkspaceFileNavigator(vscode);

    this.connectionStatus = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.connectionStatus.command = "cantrip.reconnectBridge";
    this.identityStatus = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.identityStatus.command = "cantrip.showIdentity";
    this.agentStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98,
    );
    this.agentStatusItem.command = "cantrip.showConflicts";
    this.gitStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      97,
    );
    this.updateStatusItems();
  }

  async start() {
    const watch = (event) => {
      this.disposables.push(event(() => this.scheduleState()));
    };
    watch(vscode.workspace.onDidChangeTextDocument);
    watch(vscode.workspace.onDidOpenTextDocument);
    watch(vscode.workspace.onDidCloseTextDocument);
    watch(vscode.workspace.onDidSaveTextDocument);
    if (vscode.workspace.onDidChangeNotebookDocument) {
      watch(vscode.workspace.onDidChangeNotebookDocument);
      watch(vscode.workspace.onDidOpenNotebookDocument);
      watch(vscode.workspace.onDidCloseNotebookDocument);
      watch(vscode.workspace.onDidSaveNotebookDocument);
    }
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleState()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleState()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cantrip.bridgeUrl") ||
          event.affectsConfiguration("cantrip.bridgeToken")
        ) {
          this.reconnect(true);
        }
        if (
          event.affectsConfiguration("cantrip") ||
          event.affectsConfiguration("workbench.colorTheme")
        ) {
          this.scheduleState();
        }
      }),
    );
    this.registerCommands();
    await configureWorkbenchPresentation(configuration(), vscode.commands);
    this.reconnect(true);
    void this.initializeGit();
  }

  registerCommands() {
    const register = (name, callback) =>
      this.disposables.push(vscode.commands.registerCommand(name, callback));
    register("cantrip.saveAll", async () => {
      const result = await saveDirtyEditors();
      if (result.failed.length) {
        void vscode.window.showErrorMessage(
          `Cantrip could not save ${result.failed.length} editor${result.failed.length === 1 ? "" : "s"}.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          result.saved.length
            ? `Cantrip saved ${result.saved.length} editor${result.saved.length === 1 ? "" : "s"}.`
            : "All editors are already saved.",
        );
      }
      this.scheduleState();
      return result;
    });
    register("cantrip.reconnectBridge", () => this.reconnect(true));
    register("cantrip.showIdentity", () => {
      const current = identity();
      void vscode.window.showInformationMessage(
        `${current.projectName} · ${current.worktreeName} · ${current.workerName}`,
      );
    });
    register("cantrip.showDirtyEditors", () =>
      this.showEditors(dirtyEditors()),
    );
    register("cantrip.showConflicts", () => this.showEditors(this.conflicts));
  }

  async showEditors(editors) {
    if (!editors.length) {
      void vscode.window.showInformationMessage("No matching Cantrip editors.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      editors.map((editor) => ({
        label: editor.relativePath ?? editor.uri,
        description: editor.untitled ? "Untitled" : undefined,
        editor,
      })),
      { placeHolder: "Choose an editor to reveal" },
    );
    if (!selected) return;
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(selected.editor.uri),
      );
      await vscode.window.showTextDocument(document);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not open ${selected.label}: ${errorText(error)}`,
      );
    }
  }

  async initializeGit() {
    try {
      const extension = vscode.extensions.getExtension("vscode.git");
      const exports = extension ? await extension.activate() : null;
      this.git = exports?.getAPI?.(1) ?? null;
      if (this.git?.onDidOpenRepository) {
        this.gitDisposables.push(
          this.git.onDidOpenRepository(() => this.attachGitRepositories()),
          this.git.onDidCloseRepository(() => this.attachGitRepositories()),
        );
      }
      this.attachGitRepositories();
    } catch {
      this.git = null;
      this.updateStatusItems();
    }
  }

  attachGitRepositories() {
    for (const disposable of this.gitRepositoryDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const repository of this.git?.repositories ?? []) {
      if (repository.state?.onDidChange) {
        this.gitRepositoryDisposables.push(
          repository.state.onDidChange(() => this.scheduleState()),
        );
      }
    }
    this.scheduleState();
  }

  repository() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    return (
      (this.git?.repositories ?? []).find(
        (repository) =>
          repository.rootUri?.toString() === folder.uri.toString(),
      ) ??
      this.git?.repositories?.[0] ??
      null
    );
  }

  gitState() {
    const repository = this.repository();
    if (!repository?.state) return null;
    const state = repository.state;
    return {
      branch: state.HEAD?.name ?? null,
      head: state.HEAD?.commit ?? null,
      ahead: Math.max(0, state.HEAD?.ahead ?? 0),
      behind: Math.max(0, state.HEAD?.behind ?? 0),
      staged: state.indexChanges?.length ?? 0,
      unstaged: state.workingTreeChanges?.length ?? 0,
      untracked:
        state.workingTreeChanges?.filter((change) => change.status === 7)
          .length ?? 0,
      conflicts: state.mergeChanges?.length ?? 0,
    };
  }

  reconnect(resetAttempt = false) {
    if (resetAttempt) this.reconnectAttempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const previous = this.socket;
    this.socket = null;
    if (previous && previous.readyState < 2) {
      previous.close(1000, "Cantrip bridge reconnecting");
    }
    if (this.cancelled) return;
    const { token, url } = bridgeConfiguration();
    if (!url || !token || typeof globalThis.WebSocket !== "function") {
      bridgeLog("warn", "configuration unavailable", {
        hasToken: Boolean(token),
        hasUrl: Boolean(url),
        hasWebSocket: typeof globalThis.WebSocket === "function",
        sessionId: identity().sessionId,
      });
      this.updateStatusItems();
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      bridgeLog("warn", "configuration URL invalid", {
        error: errorText(error),
        sessionId: identity().sessionId,
      });
      this.updateStatusItems();
      return;
    }
    if (
      !["ws:", "wss:"].includes(parsed.protocol) ||
      parsed.searchParams.get("token") !== token
    ) {
      bridgeLog("warn", "configuration rejected", {
        endpoint: bridgeEndpoint(url),
        hasMatchingToken: parsed.searchParams.get("token") === token,
        protocol: parsed.protocol,
        sessionId: identity().sessionId,
      });
      this.updateStatusItems();
      return;
    }

    bridgeLog("info", "connection opening", {
      endpoint: bridgeEndpoint(url),
      sessionId: identity().sessionId,
    });
    const socket = new globalThis.WebSocket(parsed.toString());
    this.socket = socket;
    this.updateStatusItems();
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      bridgeLog("info", "connection opened", {
        endpoint: bridgeEndpoint(url),
        sessionId: identity().sessionId,
      });
      this.updateStatusItems();
      void this.publishState();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      void this.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.updateStatusItems();
      if (this.cancelled) return;
      const delay = reconnectDelayMs(this.reconnectAttempt++);
      bridgeLog("warn", "connection closed", {
        code: event.code,
        delayMs: delay,
        endpoint: bridgeEndpoint(url),
        reason: event.reason?.slice(0, 256) ?? "",
        sessionId: identity().sessionId,
      });
      this.reconnectTimer = setTimeout(() => this.reconnect(false), delay);
    });
    observeSocketErrors(socket, (readyState) => {
      bridgeLog("warn", "connection error", {
        endpoint: bridgeEndpoint(url),
        readyState,
        sessionId: identity().sessionId,
      });
    });
  }

  async onMessage(data) {
    let raw;
    if (typeof data === "string") raw = data;
    else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString();
    else if (data && typeof data.text === "function") raw = await data.text();
    else return;
    const request = parseRequest(raw);
    if (!request) return;
    try {
      const result = await this.handleRequest(request.method, request.params);
      this.send({ type: "response", id: request.id, ok: true, result });
    } catch (error) {
      this.send({
        type: "response",
        id: request.id,
        ok: false,
        error: errorText(error).slice(0, 4_000),
      });
    }
  }

  async handleRequest(method, params) {
    if (method === "saveAll") return saveDirtyEditors();
    if (method === "prepareAgentTurn") return this.prepareAgentTurn();
    if (method === "setTheme") {
      await this.setTheme(params);
      return { applied: true };
    }
    if (method === "setPresentation") {
      await this.setPresentation(params);
      return { applied: true, presentation: params.presentation };
    }
    if (method === "externalFilesChanged") {
      return this.externalFilesChanged(params.paths);
    }
    if (method === "openFile") return this.openFile(params);
    if (method === "agentTurnState") return this.agentTurnState(params);
    if (method === "ping") return { connected: true };
    throw new Error(`Unsupported Cantrip workbench method: ${method}`);
  }

  async prepareAgentTurn() {
    const policy = configuration().get("saveBeforeAgentTurn", "always");
    const dirty = dirtyEditors();
    if (!dirty.length || policy === "never") {
      return {
        allowed: true,
        policy,
        dirtyEditors: dirty,
        saved: [],
        failed: [],
        reason: null,
      };
    }
    if (policy === "ask") {
      return {
        allowed: false,
        policy,
        dirtyEditors: dirty,
        saved: [],
        failed: [],
        reason:
          "Cantrip Code has unsaved editors. Save or discard them before sending this prompt.",
      };
    }
    const result = await saveDirtyEditors();
    this.scheduleState();
    return {
      allowed: result.failed.length === 0,
      policy,
      dirtyEditors: dirtyEditors(),
      saved: result.saved,
      failed: result.failed,
      reason: result.failed.length
        ? `Cantrip Code could not save ${result.failed.length} editor${result.failed.length === 1 ? "" : "s"}.`
        : null,
    };
  }

  async openFile(params) {
    const result = await this.fileNavigator.open(
      params.path,
      params.expectedWorkspaceRootUri,
    );
    this.scheduleState();
    return result;
  }

  async setPresentation(params) {
    await setWorkbenchPresentation(
      params.presentation,
      vscode.workspace,
      vscode.commands,
      vscode.ConfigurationTarget.Workspace,
    );
    this.scheduleState();
  }

  async setTheme(params) {
    const appearance = params.appearance;
    const theme = themeNameForAppearance(appearance);
    if (!theme) {
      throw new Error(`Unknown Cantrip appearance: ${String(appearance)}`);
    }
    await forceColorTheme(
      vscode.workspace.getConfiguration("workbench"),
      theme,
      vscode.ConfigurationTarget.Workspace,
    );
    bridgeLog("info", "theme applied", {
      appearance,
      sessionId: identity().sessionId,
      theme,
    });
  }

  async agentTurnState(params) {
    const phase = params.phase;
    if (!["started", "completed", "failed"].includes(phase)) {
      throw new Error("Invalid Cantrip agent turn phase.");
    }
    this.agentStatus = phase === "started" ? "running" : phase;
    let changed = { refreshed: [], conflicts: [] };
    if (phase !== "started") {
      changed = await this.externalFilesChanged(params.paths);
    }
    const notifications = configuration().get(
      "agentNotifications",
      "conflicts",
    );
    if (phase === "started" && notifications === "all") {
      void vscode.window.showInformationMessage(
        "Cantrip agent is editing this worktree.",
      );
    } else if (
      phase === "completed" &&
      notifications === "all" &&
      changed.conflicts.length === 0
    ) {
      void vscode.window.showInformationMessage(
        changed.refreshed.length
          ? `Cantrip agent changed ${changed.refreshed.length} file${changed.refreshed.length === 1 ? "" : "s"}.`
          : "Cantrip agent finished without file changes.",
      );
    }
    this.scheduleState();
    return changed;
  }

  async externalFilesChanged(value) {
    const paths = safeRelativePaths(value);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !paths.length) return { refreshed: [], conflicts: [] };
    const open = new Map(
      [
        ...vscode.workspace.textDocuments,
        ...(vscode.workspace.notebookDocuments ?? []),
      ].map((document) => [document.uri.toString(), document]),
    );
    const refreshed = [];
    const conflicts = [];
    for (const item of paths) {
      const uri = vscode.Uri.joinPath(folder.uri, ...item.split("/"));
      const document = open.get(uri.toString());
      if (document?.isDirty) {
        conflicts.push({
          uri: document.uri.toString(),
          relativePath: item,
          untitled: false,
          dirty: true,
        });
      } else {
        refreshed.push(item);
      }
    }
    this.conflicts = conflicts;
    await vscode.commands.executeCommand(
      "workbench.files.action.refreshFilesExplorer",
    );
    await this.repository()
      ?.status?.()
      .catch(() => undefined);
    if (
      conflicts.length &&
      configuration().get("agentNotifications", "conflicts") !== "off"
    ) {
      const action = await vscode.window.showWarningMessage(
        `Cantrip agent changed ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} that still ${conflicts.length === 1 ? "has" : "have"} unsaved editor changes. The buffers were not replaced.`,
        "Show conflicts",
      );
      if (action) void vscode.commands.executeCommand("cantrip.showConflicts");
    }
    this.scheduleState();
    return { refreshed, conflicts };
  }

  scheduleState() {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => void this.publishState(), 75);
  }

  async publishState() {
    this.stateTimer = null;
    const dirty = dirtyEditors();
    const dirtyUris = new Set(dirty.map((editor) => editor.uri));
    this.conflicts = this.conflicts.filter((editor) =>
      dirtyUris.has(editor.uri),
    );
    const git = this.gitState();
    this.updateStatusItems(git);
    this.send({
      type: "state",
      dirtyEditors: dirty,
      activeEditor: activeEditorState(),
      git,
      conflicts: this.conflicts,
      savePolicy: configuration().get("saveBeforeAgentTurn", "always"),
      agentStatus: this.agentStatus,
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  updateStatusItems(git = this.gitState()) {
    const connected = this.socket?.readyState === 1;
    this.connectionStatus.text = connected
      ? "$(plug) Cantrip"
      : "$(debug-disconnect) Cantrip";
    this.connectionStatus.tooltip = connected
      ? "Connected to the authenticated Cantrip worker bridge"
      : "Cantrip worker bridge disconnected — click to reconnect";
    this.connectionStatus.show();

    const current = identity();
    this.identityStatus.text = `$(worktree) ${current.worktreeName}`;
    this.identityStatus.tooltip = `${current.projectName} · ${current.workerName}\nProject ${current.projectId}\nWorktree ${current.worktreeId}`;
    this.identityStatus.show();

    if (this.agentStatus === "running") {
      this.agentStatusItem.text = "$(sync~spin) Agent editing";
      this.agentStatusItem.tooltip =
        "A Cantrip agent turn is active in this worktree";
      this.agentStatusItem.show();
    } else if (this.conflicts.length) {
      this.agentStatusItem.text = `$(warning) ${this.conflicts.length} conflict${this.conflicts.length === 1 ? "" : "s"}`;
      this.agentStatusItem.tooltip =
        "Agent file changes overlap unsaved editor buffers";
      this.agentStatusItem.show();
    } else {
      this.agentStatusItem.hide();
    }

    if (git) {
      const changes = git.staged + git.unstaged + git.conflicts;
      this.gitStatusItem.text = `$(git-branch) ${git.branch ?? "detached"}${changes ? ` · ${changes}` : ""}`;
      this.gitStatusItem.tooltip = `Git ${git.head?.slice(0, 8) ?? "no HEAD"}\n${git.staged} staged · ${git.unstaged} unstaged · ${git.conflicts} conflicts\n${git.ahead} ahead · ${git.behind} behind`;
      this.gitStatusItem.show();
    } else {
      this.gitStatusItem.hide();
    }
  }

  dispose() {
    this.cancelled = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.socket && this.socket.readyState < 2) {
      this.socket.close(1000, "Cantrip workbench deactivated");
    }
    for (const disposable of [
      ...this.disposables,
      ...this.gitDisposables,
      ...this.gitRepositoryDisposables,
    ]) {
      disposable.dispose();
    }
    this.connectionStatus.dispose();
    this.identityStatus.dispose();
    this.agentStatusItem.dispose();
    this.gitStatusItem.dispose();
  }
}

let coordinator = null;

async function activate(context) {
  coordinator = new WorkbenchCoordinator(context);
  context.subscriptions.push(coordinator);
  await coordinator.start();
  return {
    getState: () => ({
      identity: identity(),
      dirtyEditors: dirtyEditors(),
      activeEditor: activeEditorState(),
    }),
  };
}

function deactivate() {
  coordinator?.dispose();
  coordinator = null;
}

module.exports = { activate, deactivate };
