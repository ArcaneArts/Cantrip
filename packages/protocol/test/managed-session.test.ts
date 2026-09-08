import { describe, expect, it } from "vitest";

import {
  managedSessionContextSchema,
  workerCommandSchema,
} from "../src/index.js";

const session = {
  chatId: "chat-1",
  computerUseEnabled: true,
  contextKind: "project" as const,
  projectId: "project-1",
  worktreeId: "worktree-1",
  rootKind: "git-worktree" as const,
  scratchRootId: null,
};

const command = {
  type: "chat.thread.ensure",
  session,
  cwd: "/workspace/project",
  threadId: null,
  planMode: "default",
  permissionProfileId: ":workspace",
  model: {
    id: "root",
    name: "root-model",
    routeId: "route-1",
    reasoningEffort: null,
  },
  provider: {
    id: "provider",
    name: "provider",
    kind: "openai-compatible",
    baseUrl: "https://provider.invalid/v1",
  },
  subagentDefaults: {
    model: {
      id: "child",
      name: "child-model",
      routeId: "child-route",
      reasoningEffort: "high",
    },
    provider: {
      id: "provider",
      name: "provider",
      kind: "openai-compatible",
      baseUrl: "https://provider.invalid/v1",
    },
  },
  mcpServers: [],
};

describe("managed session transport", () => {
  it("retains idle eligibility and child configuration without an execution lane", () => {
    const parsed = workerCommandSchema.parse(command);
    expect(parsed).toMatchObject(command);
    expect(parsed).not.toHaveProperty("executionLaneId");
    expect(parsed).not.toHaveProperty("computerUseAuthority");
  });

  it("does not manufacture a session for a legacy ensure command", () => {
    const {
      session: _session,
      subagentDefaults: _children,
      ...legacy
    } = command;
    const parsed = workerCommandSchema.parse(legacy);
    expect(parsed).not.toHaveProperty("session");
    expect(parsed).not.toHaveProperty("subagentDefaults");
  });

  it("requires explicit computer-use eligibility and rejects injected execution claims", () => {
    const { computerUseEnabled: _enabled, ...unspecified } = session;
    expect(managedSessionContextSchema.safeParse(unspecified).success).toBe(
      false,
    );
    expect(
      managedSessionContextSchema.safeParse({
        ...session,
        executionLaneId: "synthetic-lane",
      }).success,
    ).toBe(false);
    expect(
      managedSessionContextSchema.parse({
        ...session,
        computerUseEnabled: false,
      }).computerUseEnabled,
    ).toBe(false);
  });

  it("rejects mixed project and standalone placement", () => {
    expect(
      managedSessionContextSchema.safeParse({
        ...session,
        scratchRootId: "scratch-1",
      }).success,
    ).toBe(false);
    expect(
      managedSessionContextSchema.safeParse({
        ...session,
        contextKind: "standalone",
      }).success,
    ).toBe(false);
  });
});
