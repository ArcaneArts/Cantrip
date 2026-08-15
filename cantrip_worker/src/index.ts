import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";

import { AttachmentStore } from "./attachment-store.js";
import { ChatRelocationHydrationStore } from "./chat-relocation-store.js";
import { evaluateProjectAutomationCondition } from "./automation-conditions.js";
import { ProjectAutomationScheduler } from "./automation-scheduler.js";
import {
  discoverExternalChatHistory,
  readExternalChatHistory,
} from "./external-chat-history.js";
import { codexAccountHome } from "./codex/account-home.js";
import { CodexAppServer, codexRuntimeId } from "./codex/app-server.js";
import { CodexAuthClient } from "./codex/auth-client.js";
import { verifyCodexInstallation } from "./codex/bundled-runtime.js";
import { discoverCodexRuntime } from "./codex/discovery.js";
import { chatGptExternalAuthCapabilityError } from "./codex/external-chatgpt-auth.js";
import type { CodexRuntime } from "./codex/runtime.js";
import { CantripCliBroker } from "./cli-broker.js";
import { BrowserRemoteSurfaceAdapter } from "./browser/browser-adapter.js";
import { discoverBrowserServices } from "./browser/service-discovery.js";
import { discoverCantripCode } from "./code/installation.js";
import { CodeSupervisor } from "./code/supervisor.js";
import { CodeTunnelProxy } from "./code/tunnel-proxy.js";
import { CodeDirectEndpointManager } from "./code/direct-endpoint.js";
import { readWorkerConfig } from "./config.js";
import { saveWorkerCredential } from "./credential-store.js";
import { ManagedDesktopRemoteSurfaceAdapter } from "./desktop/desktop-adapter.js";
import { DesktopApplicationIconStore } from "./desktop/desktop-icons.js";
import {
  listExplorerDirectoryCommits,
  listExplorerDirectory,
  readExplorerFile,
  writeExplorerFile,
} from "./explorer.js";
import { GithubClient } from "./github.js";
import { GrokAuthClient } from "./grok-auth-client.js";
import type { GrokSubscriptionClient } from "./grok-subscription-client.js";
import {
  captureLegacyProviderCredential,
  purgeLegacyProviderCredential,
} from "./legacy-provider-credentials.js";
import { workerLogger } from "./logger.js";
import { discoverOllamaModels } from "./ollama.js";
import {
  ProviderAccessTokenClient,
  ProviderAccessTokenRequestError,
} from "./provider-access-tokens.js";
import { createServerManagedGrokClient } from "./server-managed-grok.js";
import {
  buildGitAgentPrompt,
  failedPullRequestChecksEvidence,
} from "./git-agent.js";
import {
  amendGitManagedOperation,
  applyGitForcePush,
  applyGitLfsAction,
  applyGitBranchAction,
  applyGitCommitAction,
  applyGitConflictResolution,
  applyGitPartialPatch,
  applyGitRemoteAction,
  applyGitRecoveryAction,
  applyGitStashAction,
  applyGitSubmoduleAction,
  applyGitTagAction,
  controlGitManagedOperation,
  createGitStash,
  inspectGitManagedOperation,
  listGitConflicts,
  previewGitBranchAction,
  previewGitCommitAction,
  previewGitConflictResolution,
  previewGitPartialPatch,
  previewGitRemoteAction,
  previewGitRecoveryAction,
  previewGitStashAction,
  previewGitSubmoduleAction,
  previewGitTagAction,
  previewGitManagedOperation,
  previewGitForcePush,
  previewGitLfsAction,
  readGitCommitDetail,
  readGitCommitSignature,
  readGitConflict,
  readGitBranches,
  readGitComparison,
  readGitFileDiff,
  readGitFileBlame,
  readGitFileHistory,
  readGitHistory,
  readGitLfsStatus,
  readGitRemotes,
  readGitRecoveryCandidates,
  readGitRevisionFileDiff,
  readGitRevisionCandidates,
  readGitStatus,
  readGitStashes,
  readGitStashFileDiff,
  readGitSubmodules,
  readGitTagDetail,
  readGitTags,
  searchGitCommits,
  runGitAction,
  startGitManagedOperation,
} from "./git.js";
import { createHeartbeat, sendHeartbeat } from "./heartbeat.js";
import { DirectBroker } from "./direct-broker.js";
import { enrollWorker } from "./enrollment.js";
import { ProjectShareManager } from "./project-share-manager.js";
import { ProjectShareTunnelDestinationAdapter } from "./project-share-tunnel-adapter.js";
import { readProjectRepositoryStats } from "./project-repository-stats.js";
import { discoverScriptCommands } from "./script-command-discovery.js";
import { TerminalManager } from "./terminal-manager.js";
import { TerminalDirectEndpointManager } from "./terminal-direct-endpoint.js";
import { TunnelTcpDestinationAdapter } from "./tunnel-tcp-adapter.js";
import { TunnelDestinationRouter } from "./tunnel-destination-router.js";
import { RemoteSurfaceManager } from "./remote-surface-manager.js";
import { SkillManager } from "./skill-manager.js";
import { WorkerConnection } from "./transport.js";
import { WorktreeManager } from "./worktrees.js";
import {
  scanWorkflowRepository,
  writeWorkflowRepositoryDocument,
} from "./workflow-repository.js";

type GrokSubscriptionOperations = Pick<
  GrokSubscriptionClient,
  "listModels" | "localProxyBaseUrl"
>;

const HEARTBEAT_INTERVAL_MS = 5_000;

async function start(): Promise<void> {
  const config = readWorkerConfig();
  const bundledCodex = await verifyCodexInstallation(config.codexInstallation);
  const codexHome = path.join(config.dataDirectory, "codex-home");
  const codexRuntime = await discoverCodexRuntime(
    config.codexBinary,
    path.join(config.dataDirectory, "codex-compatibility-probe"),
  );
  if (bundledCodex && codexRuntime.version?.semantic !== bundledCodex.version) {
    throw new Error(
      `Bundled Codex reports ${codexRuntime.version?.semantic ?? "no version"}; manifest expects ${bundledCodex.version}.`,
    );
  }
  const browserAdapter = new BrowserRemoteSurfaceAdapter({
    dataDirectory: config.dataDirectory,
  });
  const desktopAdapter = new ManagedDesktopRemoteSurfaceAdapter(
    undefined,
    undefined,
    undefined,
    undefined,
    new DesktopApplicationIconStore(config.dataDirectory),
  );
  await desktopAdapter.initialize();
  const codeDiscovery = await discoverCantripCode();
  const code = new CodeSupervisor({
    capabilities: codeDiscovery.capabilities,
    dataDirectory: config.dataDirectory,
    idleTimeoutMs: config.codeIdleTimeoutMs,
    installation: codeDiscovery.installation,
    workerId: config.workerId,
    workerName: config.name,
  });
  await code.start();
  const codeTunnel = new CodeTunnelProxy(code);
  const codeDirectEndpoints = new CodeDirectEndpointManager(code);
  const cliBroker = new CantripCliBroker(config);
  const terminals = new TerminalManager({
    environment: cliBroker.childEnvironment(),
  });
  const terminalDirectEndpoints = new TerminalDirectEndpointManager(terminals);
  const directBroker = new DirectBroker();
  directBroker.setTunnelTargetResolver(async (binding, target) => {
    if (target.kind !== "adapter") {
      return target;
    }
    if (target.adapter === "code") {
      if (
        binding.resourceKind !== "code" ||
        binding.resourceId !== target.resourceId
      ) {
        throw new Error("Direct Code target escaped its capability binding.");
      }
      return codeDirectEndpoints.prepare(
        binding.capabilityId,
        target.resourceId,
      );
    }
    if (target.adapter !== "terminal") return target;
    if (
      binding.resourceKind !== "terminal" ||
      binding.resourceId !== target.resourceId
    ) {
      throw new Error("Direct terminal target escaped its capability binding.");
    }
    return terminalDirectEndpoints.prepare(
      binding.capabilityId,
      target.resourceId,
    );
  });
  directBroker.setCapabilityRevoker((capabilityId, reason) => {
    terminalDirectEndpoints.revoke(capabilityId, reason);
    codeDirectEndpoints.revoke(capabilityId, reason);
  });
  await directBroker.start();
  const heartbeat = createHeartbeat(
    config,
    codexRuntime,
    new Date().toISOString(),
    {
      browser: browserAdapter.available,
      desktop: desktopAdapter.available,
      transports: ["websocket", "webrtc"],
      iceTransportPolicies: ["all", "relay"],
      maxSessions: 4,
    },
    codeDiscovery.capabilities,
    directBroker.advertisement,
  );
  await enrollWorker(config, heartbeat);
  let connected = false;
  let commandChannelStarted = false;
  let heartbeatInFlight: Promise<void> | null = null;
  let lastConnectionError: string | null = null;
  let stopping = false;
  const attachments = new AttachmentStore(config.dataDirectory);
  const chatRelocations = new ChatRelocationHydrationStore(
    config.dataDirectory,
  );
  const github = new GithubClient(config.dataDirectory);
  const codexAuthClients = new Map<string, CodexAuthClient>();
  const grokAuthClients = new Map<string, GrokAuthClient>();
  const providerAccessTokens = new ProviderAccessTokenClient(config);
  const serverManagedGrokClients = new Map<string, GrokSubscriptionClient>();
  const codexRuntimes = new Map<string, CodexRuntime>();
  const codexCatalogRuntimes = new Map<string, CodexAppServer>();
  const pausedChats = new Set<string>();
  const projectShares = new ProjectShareManager();
  const projectShareTunnel = new ProjectShareTunnelDestinationAdapter(
    projectShares,
  );
  const tunnelTcpDestination = new TunnelTcpDestinationAdapter();
  const tunnelDestinations = new TunnelDestinationRouter(
    tunnelTcpDestination,
    projectShareTunnel,
    codeTunnel,
  );
  const skillManager = new SkillManager(config.dataDirectory);
  const remoteSurfaces = new RemoteSurfaceManager({
    browser: browserAdapter,
    desktop: desktopAdapter,
  });
  const worktrees = new WorktreeManager(config.dataDirectory);
  const automationScheduler = new ProjectAutomationScheduler({
    serverUrl: config.serverUrl,
    token: config.token,
    workerId: config.workerId,
  });

  const accountHomeFor = (credentialHomeKey: string) =>
    codexAccountHome(config.dataDirectory, credentialHomeKey);

  const authFor = (credentialHomeKey: string) => {
    let client = codexAuthClients.get(credentialHomeKey);
    if (!client) {
      client = new CodexAuthClient(
        config.codexBinary,
        accountHomeFor(credentialHomeKey),
      );
      codexAuthClients.set(credentialHomeKey, client);
    }
    return client;
  };

  const grokFor = (credentialHomeKey: string) => {
    let client = grokAuthClients.get(credentialHomeKey);
    if (!client) {
      client = new GrokAuthClient(accountHomeFor(credentialHomeKey));
      grokAuthClients.set(credentialHomeKey, client);
    }
    return client;
  };

  const serverManagedGrokFor = (providerId: string, accountId: string) => {
    const key = `${providerId}:${accountId}`;
    let client = serverManagedGrokClients.get(key);
    if (!client) {
      client = createServerManagedGrokClient(
        providerId,
        accountId,
        providerAccessTokens,
      );
      serverManagedGrokClients.set(key, client);
    }
    return client;
  };

  const legacyGrokFallback = (error: unknown) =>
    error instanceof ProviderAccessTokenRequestError &&
    (error.status === 404 ||
      error.code === "credential-unavailable" ||
      error.code === "migration-needed");

  const withGrokSubscription = async <T>(
    provider: {
      accountId: string;
      credentialHomeKey: string;
      id: string;
    },
    operation: (client: GrokSubscriptionOperations) => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation(
        serverManagedGrokFor(provider.id, provider.accountId),
      );
    } catch (error) {
      if (!legacyGrokFallback(error)) throw error;
      return operation(grokFor(provider.credentialHomeKey));
    }
  };

  const accountBackedProvider = (kind: string) =>
    kind === "chatgpt" || kind === "grok";

  const runtimeFor = (command: {
    model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
    provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
  }) => {
    const runtimeId = codexRuntimeId(command.model, command.provider);
    let runtime = codexRuntimes.get(runtimeId);
    if (!runtime) {
      const directoryName = createHash("sha256")
        .update(runtimeId)
        .digest("hex");
      runtime = new CodexAppServer(
        config.codexBinary,
        path.join(config.dataDirectory, "codex-runtimes", directoryName),
        accountBackedProvider(command.provider.kind)
          ? accountHomeFor(
              command.provider.credentialHomeKey ?? command.provider.id,
            )
          : codexHome,
        codexRuntime,
        undefined,
        async (provider) =>
          provider.kind === "grok"
            ? {
                ...provider,
                baseUrl:
                  provider.accountId && provider.credentialHomeKey
                    ? await withGrokSubscription(
                        {
                          accountId: provider.accountId,
                          credentialHomeKey: provider.credentialHomeKey,
                          id: provider.id,
                        },
                        (client) => client.localProxyBaseUrl(),
                      )
                    : provider.baseUrl,
              }
            : provider,
        providerAccessTokens,
      );
      codexRuntimes.set(runtimeId, runtime);
    }
    return runtime;
  };

  const catalogRuntimeFor = (credentialHomeKey: string) => {
    let runtime = codexCatalogRuntimes.get(credentialHomeKey);
    if (!runtime) {
      const directoryName = createHash("sha256")
        .update(`catalog:${credentialHomeKey}`)
        .digest("hex");
      runtime = new CodexAppServer(
        config.codexBinary,
        path.join(config.dataDirectory, "codex-catalogs", directoryName),
        accountHomeFor(credentialHomeKey),
        codexRuntime,
        undefined,
        undefined,
        providerAccessTokens,
      );
      codexCatalogRuntimes.set(credentialHomeKey, runtime);
    }
    return runtime;
  };

  const closeAccountRuntimes = (credentialHomeKey: string) => {
    for (const [runtimeId, runtime] of codexRuntimes) {
      if (!runtimeId.startsWith(`${credentialHomeKey}:`)) continue;
      runtime.close();
      codexRuntimes.delete(runtimeId);
    }
    codexCatalogRuntimes.get(credentialHomeKey)?.close();
    codexCatalogRuntimes.delete(credentialHomeKey);
  };

  const handleCommand = async (
    command: WorkerCommand,
    emit: (event: WorkerEvent) => void,
  ): Promise<unknown> => {
    switch (command.type) {
      case "direct.capability.prepare":
        if (command.binding.workerId !== config.workerId) {
          throw new Error("Direct capability targets another worker.");
        }
        return directBroker.prepare(command);
      case "direct.capability.revoke":
        return {
          revoked: directBroker.revoke(command.capabilityId, command.reason),
        };
      case "direct.capability.renew":
        return {
          renewed: directBroker.renew(
            command.capabilityId,
            command.leaseExpiresAt,
          ),
        };
      case "worker.version":
        return cantripVersion;
      case "worker.credential.rotate":
        saveWorkerCredential({
          credential: command.credential,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        config.token = command.credential;
        config.tokenSource = "persisted";
        return { accepted: true };
      case "model.ollama.catalog":
        return discoverOllamaModels(command.baseUrl, command.apiKey);
      case "model.chatgpt.catalog":
        return catalogRuntimeFor(
          command.provider.credentialHomeKey,
        ).listChatGptModels(command.provider);
      case "model.grok.catalog":
        return withGrokSubscription(command.provider, (client) =>
          client.listModels(),
        );
      case "codex.auth.status":
        return command.providerKind === "grok"
          ? grokFor(command.credentialHomeKey ?? command.providerId).status()
          : authFor(command.credentialHomeKey ?? command.providerId).status();
      case "codex.auth.login.start":
        return command.providerKind === "grok"
          ? grokFor(
              command.credentialHomeKey ?? command.providerId,
            ).startDeviceLogin()
          : authFor(
              command.credentialHomeKey ?? command.providerId,
            ).startDeviceLogin();
      case "codex.auth.logout":
        closeAccountRuntimes(command.credentialHomeKey ?? command.providerId);
        if (command.providerKind === "grok") {
          await grokFor(
            command.credentialHomeKey ?? command.providerId,
          ).logout();
        } else {
          await authFor(
            command.credentialHomeKey ?? command.providerId,
          ).logout();
        }
        return { accepted: true };
      case "provider.auth.legacy.capture": {
        const captured = await captureLegacyProviderCredential(
          accountHomeFor(command.credentialHomeKey),
          command.providerKind,
        );
        return captured.status === "available"
          ? {
              ...captured,
              serverManagedAuth:
                command.providerKind === "grok"
                  ? true
                  : chatGptExternalAuthCapabilityError(codexRuntime) === null,
            }
          : captured;
      }
      case "provider.auth.legacy.purge": {
        closeAccountRuntimes(command.credentialHomeKey);
        providerAccessTokens.clear(
          command.providerId,
          command.providerAccountId,
        );
        if (command.providerKind === "grok") {
          grokAuthClients.get(command.credentialHomeKey)?.close();
          grokAuthClients.delete(command.credentialHomeKey);
          serverManagedGrokClients
            .get(`${command.providerId}:${command.providerAccountId}`)
            ?.close();
          serverManagedGrokClients.delete(
            `${command.providerId}:${command.providerAccountId}`,
          );
        } else {
          // Deliberately stop and remove the local file without account/logout;
          // Codex logout revokes the shared OAuth credential on the provider.
          codexAuthClients.get(command.credentialHomeKey)?.close();
          codexAuthClients.delete(command.credentialHomeKey);
        }
        return purgeLegacyProviderCredential(
          accountHomeFor(command.credentialHomeKey),
          command.providerKind,
          command.expectedSubject,
          command.serverCredentialRevision,
        );
      }
      case "github.auth.status":
        return github.authStatus();
      case "github.repositories.cached":
        return github.cachedRepositories(command.login);
      case "github.repositories.list":
        return github.listRepositories();
      case "github.repository-owners.list":
        return github.listRepositoryOwners();
      case "github.repositories.create":
        return github.createRepository(command.request);
      case "automation.condition.evaluate":
        return evaluateProjectAutomationCondition(
          command.condition,
          command.cwd,
          command.repository,
          {
            countOpenIssues: (repository) => github.countOpenIssues(repository),
          },
        );
      case "github.issues.list":
        return github.listIssues(
          command.repository,
          command.kind,
          command.state,
          command.page,
          command.limit,
        );
      case "github.issue.get":
        return github.getIssue(command.repository, command.number);
      case "github.issue.comment":
        return github.commentOnIssue(
          command.repository,
          command.number,
          command.body,
        );
      case "github.issue.close":
        return github.closeIssue(
          command.repository,
          command.number,
          command.comment,
        );
      case "github.pull-request.create":
        return github.createPullRequest(
          command.repository,
          command.cwd,
          command.request,
        );
      case "github.pull-request.get":
        return github.getPullRequest(
          command.repository,
          command.cwd,
          command.number,
        );
      case "github.pull-request.comment":
        return github.commentOnPullRequest(
          command.repository,
          command.cwd,
          command.number,
          command.body,
        );
      case "github.pull-request.review.submit":
        return github.submitPullRequestReview(
          command.repository,
          command.cwd,
          command.number,
          command.review,
        );
      case "github.pull-request.review.comment":
        return github.commentOnPullRequestLine(
          command.repository,
          command.cwd,
          command.number,
          command.comment,
        );
      case "github.pull-request.review.reply":
        return github.replyToPullRequestReview(
          command.repository,
          command.cwd,
          command.number,
          command.commentId,
          command.body,
        );
      case "github.pull-request.lifecycle.preview":
        return github.previewPullRequestLifecycle(
          command.repository,
          command.cwd,
          command.number,
          command.action,
        );
      case "github.pull-request.lifecycle.apply":
        return github.applyPullRequestLifecycle(
          command.repository,
          command.cwd,
          command.number,
          command.request,
        );
      case "github.pull-request.checkout.prepare":
        return github.preparePullRequestCheckout(
          command.repository,
          command.cwd,
          command.number,
        );
      case "github.releases.list":
        return github.listReleases(command.repository);
      case "github.release.get":
        return github.getRelease(command.repository, command.releaseId);
      case "github.release.create":
        return github.createRelease(
          command.repository,
          command.cwd,
          command.request,
        );
      case "project.clone":
        return github.cloneRepository(command.repository.nameWithOwner);
      case "project.replica.provision":
        return github.provisionReplica(
          {
            jobId: command.jobId,
            attempt: command.attempt,
            nameWithOwner: command.repository.nameWithOwner,
            expectedRevision: command.expectedRevision,
          },
          (progress) =>
            emit({
              type: "project.replica.progress",
              jobId: command.jobId,
              attempt: command.attempt,
              progress,
            }),
        );
      case "project.replica.synchronize":
        return github.synchronizeReplica(
          {
            jobId: command.jobId,
            attempt: command.attempt,
            nameWithOwner: command.repository.nameWithOwner,
            sourcePath: command.sourcePath,
            expectedRevision: command.expectedRevision,
            policy: command.policy,
          },
          (progress) =>
            emit({
              type: "project.replica.progress",
              jobId: command.jobId,
              attempt: command.attempt,
              progress,
            }),
        );
      case "project.replica.remove":
        return github.removeReplica(
          {
            jobId: command.jobId,
            attempt: command.attempt,
            nameWithOwner: command.repository.nameWithOwner,
            sourcePath: command.sourcePath,
            deleteLocalFiles: command.deleteLocalFiles,
          },
          (progress) =>
            emit({
              type: "project.replica.progress",
              jobId: command.jobId,
              attempt: command.attempt,
              progress,
            }),
        );
      case "project.files.delete":
        return github.deleteRepository(command.path);
      case "project.script-commands":
        return discoverScriptCommands(command.cwd);
      case "project.repository-stats":
        return readProjectRepositoryStats(command.cwd);
      case "external.chat-history.discover":
        return discoverExternalChatHistory(
          {
            binary: config.codexBinary,
            managedDataDirectory: config.dataDirectory,
          },
          command,
        );
      case "external.chat-history.read":
        return readExternalChatHistory(
          {
            binary: config.codexBinary,
            managedDataDirectory: config.dataDirectory,
          },
          command,
        );
      case "browser.services.discover":
        return discoverBrowserServices({ workerId: config.workerId });
      case "project.share.open":
        return projectShares.open(command);
      case "project.share.close":
        projectShareTunnel.closeShare(command.shareId);
        await projectShares.close(command.shareId);
        return { accepted: true };
      case "git.history":
        return readGitHistory(
          command.cwd,
          command.limit,
          command.cursor,
          command.revisions,
        );
      case "git.file.history":
        return readGitFileHistory(
          command.cwd,
          command.path,
          command.revision,
          command.limit,
          command.cursor,
        );
      case "git.file.blame":
        return readGitFileBlame(
          command.cwd,
          command.path,
          command.revision,
          command.limit,
          command.cursor,
        );
      case "git.commit.search":
        return searchGitCommits(
          command.cwd,
          command.query,
          command.limit,
          command.cursor,
        );
      case "git.recovery.list":
        return readGitRecoveryCandidates(
          command.cwd,
          command.kind,
          command.limit,
          command.cursor,
        );
      case "git.recovery.preview":
        return previewGitRecoveryAction(command.cwd, command.action);
      case "git.recovery.apply":
        return applyGitRecoveryAction(
          command.cwd,
          command.request.action,
          command.request.token,
          command.request.confirmation,
        );
      case "git.commit.get":
        return readGitCommitDetail(
          command.cwd,
          command.revision,
          command.parentIndex,
          command.revisions,
        );
      case "git.commit.signature.get":
        return readGitCommitSignature(command.cwd, command.revision);
      case "git.refs.list":
        return readGitRevisionCandidates(command.cwd);
      case "git.compare":
        return readGitComparison(
          command.cwd,
          command.left,
          command.right,
          command.mode,
        );
      case "git.revision.diff":
        return readGitRevisionFileDiff(
          command.cwd,
          command.revision,
          command.baseRevision,
          command.path,
        );
      case "git.status":
        return readGitStatus(command.cwd);
      case "git.diff":
        return readGitFileDiff(command.cwd, command.path, command.scope);
      case "git.patch.preview":
        return previewGitPartialPatch(command.cwd, command.request);
      case "git.patch.apply":
        return applyGitPartialPatch(
          command.cwd,
          command.request,
          command.token,
        );
      case "git.stash.list":
        return readGitStashes(command.cwd);
      case "git.stash.create":
        return createGitStash(command.cwd, command.request);
      case "git.stash.diff":
        return readGitStashFileDiff(command.cwd, command.hash, command.path);
      case "git.stash.action.preview":
        return previewGitStashAction(command.cwd, command.action);
      case "git.stash.action.apply":
        return applyGitStashAction(command.cwd, command.action, command.token);
      case "git.branch.list":
        return readGitBranches(command.cwd);
      case "git.branch.action.preview":
        return previewGitBranchAction(command.cwd, command.action);
      case "git.branch.action.apply":
        return applyGitBranchAction(command.cwd, command.action, command.token);
      case "git.remote.list":
        return readGitRemotes(command.cwd);
      case "git.remote.action.preview":
        return previewGitRemoteAction(command.cwd, command.action);
      case "git.remote.action.apply":
        return applyGitRemoteAction(command.cwd, command.action, command.token);
      case "git.submodule.list":
        return readGitSubmodules(command.cwd);
      case "git.submodule.action.preview":
        return previewGitSubmoduleAction(command.cwd, command.action);
      case "git.submodule.action.apply":
        return applyGitSubmoduleAction(
          command.cwd,
          command.action,
          command.token,
        );
      case "git.lfs.status":
        return readGitLfsStatus(command.cwd, command.refreshLocks);
      case "git.lfs.action.preview":
        return previewGitLfsAction(command.cwd, command.action);
      case "git.lfs.action.apply":
        return applyGitLfsAction(command.cwd, command.action, command.token);
      case "git.tag.list":
        return readGitTags(command.cwd);
      case "git.tag.get":
        return readGitTagDetail(command.cwd, command.name);
      case "git.tag.action.preview":
        return previewGitTagAction(command.cwd, command.action);
      case "git.tag.action.apply":
        return applyGitTagAction(command.cwd, command.action, command.token);
      case "git.commit.action.preview":
        return previewGitCommitAction(command.cwd, command.action);
      case "git.commit.action.apply":
        return applyGitCommitAction(command.cwd, command.action, command.token);
      case "git.operation.preview":
        return previewGitManagedOperation(command.cwd, command.action);
      case "git.operation.start":
        return startGitManagedOperation(
          command.cwd,
          command.action,
          command.token,
        );
      case "git.operation.inspect":
        return inspectGitManagedOperation(command.cwd, command.context);
      case "git.operation.control":
        return controlGitManagedOperation(
          command.cwd,
          command.context,
          command.action,
        );
      case "git.operation.amend":
        return amendGitManagedOperation(
          command.cwd,
          command.context,
          command.message,
        );
      case "git.conflicts.list":
        return listGitConflicts(command.cwd);
      case "git.conflicts.get":
        return readGitConflict(command.cwd, command.path);
      case "git.conflicts.preview":
        return previewGitConflictResolution(command.cwd, command.request);
      case "git.conflicts.apply":
        return applyGitConflictResolution(
          command.cwd,
          command.request,
          command.token,
        );
      case "git.action":
        return runGitAction(command.cwd, command.action);
      case "git.force-push.preview":
        return previewGitForcePush(command.cwd);
      case "git.force-push.apply":
        return applyGitForcePush(command.cwd, command.token);
      case "git.agent.generate": {
        const failedChecksEvidence =
          command.task === "summarize-failed-checks" &&
          command.repository &&
          command.pullRequestNumber
            ? failedPullRequestChecksEvidence(
                await github.getPullRequest(
                  command.repository,
                  command.cwd,
                  command.pullRequestNumber,
                ),
              )
            : null;
        return runtimeFor(command).runWorkflowNode({
          workflowRunId: `git-agent:${command.generationId}`,
          runNodeId: command.task,
          attemptId: command.generationId,
          idempotencyKey: command.generationId,
          worktreeId: null,
          cwd: command.cwd,
          threadId: null,
          prompt: await buildGitAgentPrompt(
            command.cwd,
            {
              task: command.task,
              instructions: command.instructions,
              baseRevision: command.baseRevision,
              headRevision: command.headRevision,
              pullRequestNumber: command.pullRequestNumber,
            },
            failedChecksEvidence,
          ),
          developerInstructions: command.developerInstructions,
          skillNames: [],
          outputSchema: command.outputSchema,
          mutationMode: "read-only",
          networkAccess: "none",
          approvalMode: "preauthorized",
          permissionProfileId: null,
          timeoutMs: command.timeoutMs,
          model: command.model,
          provider: command.provider,
          mcpServers: command.mcpServers,
        });
      }
      case "worktree.list":
        return worktrees.list(command.sourcePath);
      case "worktree.reconcile":
        return worktrees.reconcile(command.sourcePath);
      case "worktree.create":
        return worktrees.create(
          command.sourcePath,
          command.worktreeId,
          command.name,
          command.mode,
        );
      case "worktree.remove":
        return worktrees.remove(command.sourcePath, command.worktreePath, {
          allowExternal: command.allowExternal,
          force: command.force,
        });
      case "worktree.lock":
        return worktrees.lock(
          command.sourcePath,
          command.worktreePath,
          command.reason,
        );
      case "worktree.unlock":
        return worktrees.unlock(command.sourcePath, command.worktreePath);
      case "worktree.prune":
        return worktrees.prune(command.sourcePath, command.allowExternal);
      case "worktree.status":
        return worktrees.status(command.sourcePath, command.worktreePath);
      case "worktree.observation.configure":
        worktrees.configureObservation(command.targets);
        return { accepted: true };
      case "explorer.directory.list":
        return listExplorerDirectory(command.root, command.path);
      case "explorer.directory.commits":
        return listExplorerDirectoryCommits(command.root, command.path);
      case "explorer.file.read":
        return readExplorerFile(command.root, command.path);
      case "explorer.file.write":
        return writeExplorerFile(
          command.root,
          command.path,
          command.content,
          command.version,
        );
      case "code.probe":
        return code.probe();
      case "code.open":
        return code.open(command);
      case "code.status":
        return code.status(command.sessionId);
      case "code.stop":
        codeTunnel.closeSession(command.sessionId);
        return code.stop(command.sessionId);
      case "code.saveAll":
        return code.saveAll(command.sessionId);
      case "code.getDirtyEditors":
        return code.dirtyEditors(command.sessionId);
      case "code.setTheme":
        return code.setTheme(
          command.sessionId,
          command.themeMode,
          command.appearance,
        );
      case "code.prepareAgentTurn":
        return code.prepareAgentTurn(command.cwd);
      case "code.agentTurnState":
        return code.agentTurnState(command.cwd, command.phase, command.paths);
      case "skills.list":
        return runtimeFor(command).listSkills({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "skills.settings.list":
        return skillManager.list(command);
      case "skills.settings.read":
        return skillManager.read(command, command.skillId, command.file);
      case "skills.settings.write":
        return skillManager.write(
          command,
          command.skillId,
          command.file,
          command.content,
        );
      case "skills.settings.delete":
        return skillManager.delete(command, command.skillId);
      case "customization.inventory.read":
        return runtimeFor(command).readCustomizationInventory(
          {
            cwd: command.cwd,
            model: command.model,
            provider: command.provider,
          },
          command.forceReload,
        );
      case "customization.external.preview":
        return runtimeFor(command).previewExternalAgentConfig({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "customization.mcp.resource.read":
        return runtimeFor(command).readMcpResource({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          server: command.server,
          uri: command.uri,
        });
      case "customization.skill.configure":
        return runtimeFor(command).configureSkill({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          path: command.path,
          enabled: command.enabled,
        });
      case "customization.skill-roots.set":
        return runtimeFor(command).setSkillRoots({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          roots: command.roots,
        });
      case "customization.mcp.oauth.start":
        return runtimeFor(command).startMcpOauth({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          server: command.server,
        });
      case "customization.mcp.oauth.status":
        return runtimeFor(command).mcpOauthStatus(command.server);
      case "customization.mcp.reload":
        return runtimeFor(command).reloadMcpServers({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "customization.external.apply":
        return runtimeFor(command).applyExternalAgentConfig({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          itemIds: command.itemIds,
        });
      case "customization.external.status":
        return runtimeFor(command).externalImportStatus(command.importId);
      case "permission-profiles.list":
        return runtimeFor(command).listPermissionProfiles({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "attachment.upload.begin":
        await attachments.begin(
          command.chatId,
          command.attachmentId,
          command.fileName,
          command.sizeBytes,
        );
        return { accepted: true };
      case "attachment.upload.chunk":
        await attachments.append(
          command.chatId,
          command.attachmentId,
          command.chunkIndex,
          Buffer.from(command.data, "base64"),
        );
        return { accepted: true };
      case "attachment.upload.complete":
        return attachments.complete(command.chatId, command.attachmentId);
      case "attachment.read": {
        const result = await attachments.read(
          command.chatId,
          command.attachmentId,
          command.fileName,
          command.offset,
          command.limit,
        );
        return {
          data: Buffer.from(result.bytes).toString("base64"),
          eof: result.eof,
          sizeBytes: result.sizeBytes,
        };
      }
      case "attachment.delete":
        await attachments.remove(command.chatId, command.attachmentId);
        return { accepted: true };
      case "terminal.open":
        if (command.launch.type === "codex") {
          const runtime = runtimeFor(command.launch);
          if (
            command.launch.threadId &&
            !terminals.hasLiveSession(command.terminalId)
          ) {
            await runtime.prepareExternalSync({
              cwd: command.cwd,
              model: command.launch.model,
              provider: command.launch.provider,
              threadId: command.launch.threadId,
            });
          }
          return terminals.open(
            command.terminalId,
            command.attachmentId,
            command.cwd,
            command.cols,
            command.rows,
            {
              ...command.launch,
              binary: config.codexBinary,
              codexHome: accountBackedProvider(command.launch.provider.kind)
                ? accountHomeFor(
                    command.launch.provider.credentialHomeKey ??
                      command.launch.provider.id,
                  )
                : codexHome,
              remoteUrl: await runtime.remoteEndpoint(
                command.launch.model,
                command.launch.provider,
              ),
            },
            emit,
          );
        }
        return terminals.open(
          command.terminalId,
          command.attachmentId,
          command.cwd,
          command.cols,
          command.rows,
          command.launch,
          emit,
        );
      case "terminal.detach":
        return terminals.detach(command.terminalId, command.attachmentId);
      case "terminal.input":
        terminals.input(command.terminalId, command.data);
        return { accepted: true };
      case "terminal.resize":
        terminals.resize(command.terminalId, command.cols, command.rows);
        return { accepted: true };
      case "terminal.close":
        terminals.close(command.terminalId);
        return { accepted: true };
      case "terminal.snapshot":
        return terminals.snapshot(command.terminalId, command.maxChars);
      case "terminal.services.reconcile":
        terminals.reconcileServices(command.services);
        return { accepted: true };
      case "terminal.service.restart":
        terminals.restartService(command.terminalId);
        return { accepted: true };
      case "surface.attach":
        return remoteSurfaces.attach(command);
      case "surface.detach":
        await remoteSurfaces.detach(command.surfaceId, command.attachmentId);
        return { accepted: true };
      case "surface.configure":
        await remoteSurfaces.configure(
          command.surfaceId,
          command.configuration,
        );
        return { accepted: true };
      case "surface.suspend":
        await remoteSurfaces.suspend(command.surfaceId);
        return { accepted: true };
      case "surface.resume":
        await remoteSurfaces.resume(command.surfaceId);
        return { accepted: true };
      case "surface.close":
        await remoteSurfaces.close(command.surfaceId);
        return { accepted: true };
      case "surface.desktop.probe":
        return desktopAdapter.probe();
      case "surface.desktop.targets":
        return desktopAdapter.targets();
      case "chat.turn": {
        if (command.automationPaused) pausedChats.add(command.chatId);
        const runtime = runtimeFor(command);
        runtime.setChatPaused(command.chatId, pausedChats.has(command.chatId));
        return runtime.runTurn({
          automationPaused: pausedChats.has(command.chatId),
          attachments: command.attachments.map((attachment) => ({
            ...attachment,
            path: attachments.resolve(
              command.chatId,
              attachment.id,
              attachment.fileName,
            ),
          })),
          chatId: command.chatId,
          clientMessageId: command.clientMessageId,
          cwd: command.cwd,
          isPrimary: command.isPrimary,
          mcpServers: command.mcpServers,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          planMode: command.planMode,
          prompt: command.prompt,
          skillNames: command.skillNames,
          threadId: command.threadId,
          worktreeMode: command.worktreeMode,
          worktreePolicy: command.worktreePolicy,
          onActivity: (activity) => emit({ type: "agent.activity", activity }),
          onMessage: (message) => emit({ type: "agent.message", message }),
          onInteractionRequest: (request) =>
            emit({ type: "agent.interaction.requested", request }),
          onInteractionCleared: (requestKey) =>
            emit({ type: "agent.interaction.cleared", requestKey }),
          onInteractionExpired: (requestKey) =>
            emit({ type: "agent.interaction.expired", requestKey }),
          onCheckpoint: ({ text, turnId }) =>
            emit({ type: "agent.checkpoint", text, turnId }),
          onPlan: ({ explanation, steps, turnId }) =>
            emit({ type: "agent.plan.updated", explanation, steps, turnId }),
          onPlanQuestion: (question) =>
            emit({ type: "agent.plan.question", question }),
          onPlanQuestionResolved: (questionId) =>
            emit({ type: "agent.plan.question-resolved", questionId }),
          onThreadLoaded: (threadId) => {
            cliBroker.bindCodexThread(threadId, {
              chatId: command.chatId,
              executionLaneId: command.executionLaneId,
            });
          },
        });
      }
      case "workflow.node.execute":
        return runtimeFor(command).runWorkflowNode({
          workflowRunId: command.workflowRunId,
          runNodeId: command.runNodeId,
          attemptId: command.attemptId,
          idempotencyKey: command.idempotencyKey,
          worktreeId: command.worktreeId,
          cwd: command.cwd,
          threadId: command.threadId,
          prompt: command.prompt,
          developerInstructions: command.developerInstructions,
          skillNames: command.skillNames,
          outputSchema: command.outputSchema,
          mutationMode: command.mutationMode,
          networkAccess: command.networkAccess,
          approvalMode: command.approvalMode,
          permissionProfileId: command.permissionProfileId,
          timeoutMs: command.timeoutMs,
          model: command.model,
          provider: command.provider,
          mcpServers: command.mcpServers,
          onActivity: (activity) =>
            emit({
              type: "workflow.node.activity",
              attemptId: command.attemptId,
              activity,
            }),
          onMessage: (message) =>
            emit({
              type: "workflow.node.message",
              attemptId: command.attemptId,
              message,
            }),
          onInteractionRequest: (request) =>
            emit({
              type: "workflow.node.interaction.requested",
              attemptId: command.attemptId,
              request,
            }),
          onInteractionCleared: (requestKey) =>
            emit({
              type: "workflow.node.interaction.cleared",
              attemptId: command.attemptId,
              requestKey,
            }),
          onInteractionExpired: (requestKey) =>
            emit({
              type: "workflow.node.interaction.expired",
              attemptId: command.attemptId,
              requestKey,
            }),
          onPlan: ({ explanation, steps, turnId }) =>
            emit({
              type: "workflow.node.plan.updated",
              attemptId: command.attemptId,
              explanation,
              steps,
              turnId,
            }),
        });
      case "workflow.definition.generate":
        return runtimeFor(command).runWorkflowNode({
          workflowRunId: `generation:${command.generationId}`,
          runNodeId: "definition",
          attemptId: command.generationId,
          idempotencyKey: command.generationId,
          worktreeId: null,
          cwd: command.cwd,
          threadId: null,
          prompt: command.prompt,
          developerInstructions: command.developerInstructions,
          skillNames: [],
          outputSchema: command.outputSchema,
          mutationMode: "read-only",
          networkAccess: "none",
          approvalMode: "preauthorized",
          permissionProfileId: null,
          timeoutMs: command.timeoutMs,
          model: command.model,
          provider: command.provider,
          mcpServers: command.mcpServers,
        });
      case "workflow.repository.scan":
        return scanWorkflowRepository(command.cwd);
      case "workflow.repository.write":
        return writeWorkflowRepositoryDocument(
          command.cwd,
          command.document,
          command.overwrite,
        );
      case "workflow.node.interrupt":
        return runtimeFor(command).interruptThread(command.threadId);
      case "chat.pause.set":
        if (command.paused) {
          pausedChats.add(command.chatId);
        } else {
          pausedChats.delete(command.chatId);
        }
        for (const runtime of codexRuntimes.values()) {
          runtime.setChatPaused(command.chatId, command.paused);
        }
        return { paused: command.paused };
      case "chat.compact":
        return runtimeFor(command).compactThread({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.interrupt":
        return runtimeFor(command).interruptThread(command.threadId);
      case "chat.goal.get":
        return runtimeFor(command).getGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.goal.create":
        return runtimeFor(command).createGoal({
          cwd: command.cwd,
          model: command.model,
          objective: command.objective,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
          tokenBudget: command.tokenBudget,
        });
      case "chat.goal.update":
        return runtimeFor(command).updateGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          status: command.status,
          threadId: command.threadId,
        });
      case "chat.goal.clear":
        return runtimeFor(command).clearGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.thread.ensure":
        return runtimeFor(command).ensureThread({
          cwd: command.cwd,
          mcpServers: command.mcpServers,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          planMode: command.planMode,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.relocation.hydration.begin":
        return chatRelocations.begin(command);
      case "chat.relocation.hydration.chunk":
        await chatRelocations.append(
          command.snapshotId,
          command.chunkIndex,
          Buffer.from(command.data, "base64"),
        );
        return { accepted: true };
      case "chat.relocation.hydration.complete": {
        const upload = await chatRelocations.completeUpload(command.snapshotId);
        const runtime = runtimeFor(upload.command);
        if (upload.abandonedThreadId) {
          await runtime.discardRelocationThread(
            upload.abandonedThreadId,
            upload.command.model,
            upload.command.provider,
          );
        }
        const hydrated = await runtime.hydrateChatRelocation({
          cwd: upload.command.cwd,
          mcpServers: upload.command.mcpServers,
          model: upload.command.model,
          payload: upload.payload,
          permissionProfileId: upload.command.permissionProfileId,
          planMode: upload.command.planMode,
          provider: upload.command.provider,
          requiredSkillNames: upload.command.requiredSkillNames,
          threadId: null,
          onThreadStarted: (threadId) =>
            chatRelocations.markHydrating(
              upload.command.snapshotId,
              upload.command.transcriptSha256,
              threadId,
            ),
        });
        return chatRelocations.markHydrated(
          upload.command.snapshotId,
          upload.command.transcriptSha256,
          hydrated.threadId,
        );
      }
      case "chat.relocation.thread.release":
        if (command.discard && command.threadId) {
          await runtimeFor(command).discardRelocationThread(
            command.threadId,
            command.model,
            command.provider,
          );
          return { released: true };
        }
        return runtimeFor(command).releaseRelocationThread(
          command.threadId,
          command.model,
          command.provider,
        );
      case "chat.plan.get":
        return runtimeFor(command).getPlanMode({
          cwd: command.cwd,
          fallbackMode: command.fallbackMode,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.plan.set":
        return runtimeFor(command).setPlanMode({
          cwd: command.cwd,
          mode: command.mode,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.plan.answer":
        return runtimeFor(command).answerPlanQuestion(
          command.questionId,
          command.answers,
        );
      case "agent.interaction.respond":
        return runtimeFor(command).answerAgentInteraction(
          command.requestKey,
          command.response,
        );
      case "agent.interaction.cancel":
        return runtimeFor(command).cancelAgentInteraction(
          command.requestKey,
          command.reason,
        );
      case "chat.steer":
        return runtimeFor(command).steerThread(
          command.chatId,
          command.threadId,
          command.prompt,
          command.attachments.map((attachment) => ({
            ...attachment,
            path: attachments.resolve(
              command.chatId,
              attachment.id,
              attachment.fileName,
            ),
          })),
          command.model,
          command.provider,
        );
      case "chat.sync":
        return runtimeFor(command).syncThread({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          threadId: command.threadId,
        });
    }
  };
  const commandConnection = new WorkerConnection(
    config,
    handleCommand,
    (header, payload) => remoteSurfaces.handleFrame(header, payload),
    (header, payload) => tunnelDestinations.handleFrame(header, payload),
    () => {
      tunnelDestinations.disconnect();
      directBroker.revokeAll();
    },
  );
  directBroker.setTunnelFrameHandler((header, payload) =>
    tunnelDestinations.handleFrame(header, payload),
  );
  worktrees.setObservationEmitter((notification) =>
    commandConnection.sendNotification(notification),
  );
  remoteSurfaces.setFrameEmitter((header, payload) =>
    commandConnection.sendSurfaceFrame(header, payload),
  );
  tunnelDestinations.setFrameEmitter(
    (header, payload) => {
      const direct = directBroker.routeTunnelFrame(header, payload);
      return (
        direct ?? commandConnection.sendTunnelDataPlaneFrame(header, payload)
      );
    },
    async (attachmentId) =>
      (await directBroker.waitForTunnelCapacity(attachmentId)) ??
      commandConnection.waitForTunnelDataPlaneCapacity(),
  );
  const cliConnection = await cliBroker.start();

  workerLogger.info(`Starting ${heartbeat.name}`, {
    browser: browserAdapter.executable ?? "Chromium not found",
    cli: `${cliBroker.binary} (${cliConnection.endpoint})`,
    code: codeDiscovery.capabilities.available
      ? `${codeDiscovery.capabilities.version} (${codeDiscovery.installation?.source ?? "unknown"})`
      : `unavailable (${codeDiscovery.capabilities.reason ?? "unknown error"})`,
    codex: `${codexRuntime.version?.raw ?? "not found"} (${codexRuntime.compatibility}, ${config.codexInstallation.source})`,
    desktop: desktopAdapter.available
      ? `${desktopAdapter.frameBackend} capture ready`
      : `unavailable (${desktopAdapter.initializationError ?? "unknown error"})`,
    workerId: heartbeat.workerId,
  });

  const publishHeartbeat = async () => {
    try {
      await sendHeartbeat(config, heartbeat);
      if (!connected) {
        workerLogger.info("Connected to server", {
          serverUrl: config.serverUrl,
        });
      }
      connected = true;
      lastConnectionError = null;
      if (!commandChannelStarted) {
        commandConnection.start();
        commandChannelStarted = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopping && (connected || message !== lastConnectionError)) {
        workerLogger.warn("Waiting for server", { error: message });
      }
      connected = false;
      lastConnectionError = message;
    }
  };

  const publish = (): Promise<void> => {
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = publishHeartbeat().finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };

  await publish();
  automationScheduler.start();
  const heartbeatTimer = setInterval(
    () => void publish(),
    HEARTBEAT_INTERVAL_MS,
  );

  await new Promise<void>((resolve) => {
    const stop = async (signal: NodeJS.Signals) => {
      if (stopping) {
        return;
      }

      stopping = true;
      clearInterval(heartbeatTimer);
      automationScheduler.close();
      worktrees.close();
      commandConnection.close();
      await directBroker.close();
      terminalDirectEndpoints.close();
      codeDirectEndpoints.close();
      for (const client of codexAuthClients.values()) client.close();
      for (const client of grokAuthClients.values()) client.close();
      for (const client of serverManagedGrokClients.values()) client.close();
      terminals.closeAll();
      tunnelDestinations.close();
      await projectShares.closeAll();
      await code.close();
      await remoteSurfaces.closeAll();
      await desktopAdapter.shutdown();
      await cliBroker.close();
      for (const runtime of codexRuntimes.values()) {
        runtime.close();
      }
      for (const runtime of codexCatalogRuntimes.values()) {
        runtime.close();
      }
      workerLogger.info("Worker stopped", { signal });
      resolve();
    };

    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}

start().catch((error: unknown) => {
  workerLogger.error("Cantrip Worker failed to start", error);
  process.exitCode = 1;
});
