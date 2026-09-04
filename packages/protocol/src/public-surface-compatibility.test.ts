import { describe, expect, expectTypeOf, it } from "vitest";

import * as protocol from "./index.js";
import {
  workerCommandSchema,
  workerEventSchema,
  workerNotificationSchema,
} from "./index.js";
import type {
  AgentActivity,
  AgentInteractionRequest,
  BrowserSummary,
  CantripMcpBinding,
  CantripVersion,
  ChatRelocationJobSummary,
  ChatSummary,
  ChatTurnCreate,
  CodeTabSummary,
  CodexCustomizationInventory,
  DatabaseEngine,
  ExecutionTarget,
  ExternalChatTranscript,
  GitHistory,
  GitDiffFileSide,
  GitManagedOperationResponse,
  GithubInboxList,
  GithubAgentWorkflowContext,
  GithubPullRequestAgentContext,
  GithubPullRequestDetail,
  ProjectSummary,
  ProviderModelCatalogEntry,
  RemoteDesktopSummary,
  RemoteSurfaceCapabilities,
  SettingsBundle,
  SkillSummary,
  TerminalSummary,
  TunnelSummary,
  WorkerCommand,
  WorkerEvent,
  WorkerNotification,
  WorkerServerEnvelope,
  WorkerSummary,
  WorktreeInventory,
} from "./index.js";

function stableFingerprint(value: unknown) {
  const input = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charCodeAt(index);
    first = Math.imul(first ^ character, 0x01000193);
    second = Math.imul(second ^ character, 0x85ebca6b);
  }
  const firstHex = (first >>> 0).toString(16).padStart(8, "0");
  const secondHex = (second >>> 0).toString(16).padStart(8, "0");
  return `${firstHex}${secondHex}:${input.length}`;
}

describe("protocol public surface compatibility", () => {
  it("keeps the root runtime export surface stable", () => {
    const exportNames = Object.keys(protocol).sort();

    expect(exportNames).toHaveLength(1_944);
    expect(stableFingerprint(exportNames)).toBe("c9ba30e93353c37d:63741");
  });

  it("keeps worker discriminators stable and ordered", () => {
    const commandTypes = workerCommandSchema.options.map(
      (option) => option.shape.type.value,
    );
    const eventTypes = workerEventSchema.options.map(
      (option) => option.shape.type.value,
    );
    const notificationTypes = workerNotificationSchema.options.map(
      (option) => option.shape.type.value,
    );

    expect(commandTypes).toHaveLength(273);
    expect(stableFingerprint(commandTypes)).toBe("9715f45e8704a82a:7004");
    expect(eventTypes).toHaveLength(18);
    expect(stableFingerprint(eventTypes)).toBe("1d616530daf5093c:466");
    expect(notificationTypes).toHaveLength(14);
    expect(stableFingerprint(notificationTypes)).toBe("6768707e4d303352:420");
  });

  it("keeps representative type-only exports available from the root", () => {
    expectTypeOf<DatabaseEngine>().not.toBeNever();
    expectTypeOf<RemoteSurfaceCapabilities>().not.toBeNever();
    expectTypeOf<CantripVersion>().not.toBeNever();
    expectTypeOf<WorkerSummary>().not.toBeNever();
    expectTypeOf<SkillSummary>().not.toBeNever();
    expectTypeOf<ProviderModelCatalogEntry>().not.toBeNever();
    expectTypeOf<SettingsBundle>().not.toBeNever();
    expectTypeOf<ProjectSummary>().not.toBeNever();
    expectTypeOf<ExecutionTarget>().not.toBeNever();
    expectTypeOf<TunnelSummary>().not.toBeNever();
    expectTypeOf<GithubPullRequestDetail>().not.toBeNever();
    expectTypeOf<GithubAgentWorkflowContext>().not.toBeNever();
    expectTypeOf<GithubPullRequestAgentContext>().not.toBeNever();
    expectTypeOf<GithubInboxList>().not.toBeNever();
    expectTypeOf<GitHistory>().not.toBeNever();
    expectTypeOf<GitDiffFileSide>().not.toBeNever();
    expectTypeOf<GitManagedOperationResponse>().not.toBeNever();
    expectTypeOf<WorktreeInventory>().not.toBeNever();
    expectTypeOf<ChatSummary>().not.toBeNever();
    expectTypeOf<ChatRelocationJobSummary>().not.toBeNever();
    expectTypeOf<TerminalSummary>().not.toBeNever();
    expectTypeOf<CodeTabSummary>().not.toBeNever();
    expectTypeOf<BrowserSummary>().not.toBeNever();
    expectTypeOf<RemoteDesktopSummary>().not.toBeNever();
    expectTypeOf<AgentActivity>().not.toBeNever();
    expectTypeOf<AgentInteractionRequest>().not.toBeNever();
    expectTypeOf<CantripMcpBinding>().not.toBeNever();
    expectTypeOf<ChatTurnCreate>().not.toBeNever();
    expectTypeOf<ExternalChatTranscript>().not.toBeNever();
    expectTypeOf<CodexCustomizationInventory>().not.toBeNever();
    expectTypeOf<WorkerCommand>().not.toBeNever();
    expectTypeOf<WorkerEvent>().not.toBeNever();
    expectTypeOf<WorkerNotification>().not.toBeNever();
    expectTypeOf<WorkerServerEnvelope>().not.toBeNever();
  });
});
