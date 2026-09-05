import { describe, expect, it } from "vitest";
import { workerCommandSchema } from "./index.js";
import { cuaAgentAuthoritySchema } from "./computer-use-agent.js";

const authority = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project" as const,
  placementId: "worktree",
  executionLaneId: "lane",
  generation: 7,
  profile: {
    selectedId: ":yolo",
    effectiveId: ":read-only",
    forcedByWorktreePolicy: true,
    usesDefault: false,
  },
};
const turn = {
  type: "chat.turn" as const,
  chatId: "chat",
  clientMessageId: "message",
  executionLaneId: "lane",
  worktreeId: "worktree",
  rootKind: "git-worktree",
  cwd: "/fixture/worktree",
  isPrimary: true,
  worktreeMode: "agent-managed",
  worktreePolicy: "required-for-writes",
  policyProjectId: "project",
  threadId: null,
  prompt: "Observe a fixture",
  model: {
    id: "model",
    routeId: "route",
    name: "fixture",
    reasoningEffort: null,
  },
  provider: {
    id: "provider",
    name: "Fixture",
    kind: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
  },
  permissionProfileId: ":read-only",
  planMode: "default",
};

describe("CUA agent authority in worker dispatch", () => {
  it("preserves the complete durable authority through serialized chat.turn decoding", () => {
    const parsed = workerCommandSchema.parse(
      JSON.parse(JSON.stringify({ ...turn, computerUseAuthority: authority })),
    );
    expect(parsed).toMatchObject({ computerUseAuthority: authority });
    // The selected CUA profile remains distinct from Codex's effective profile.
    expect(parsed).toMatchObject({
      permissionProfileId: ":read-only",
      computerUseAuthority: { profile: { selectedId: ":yolo" } },
    });
  });
  it("keeps historical chat.turn commands without authority compatible", () => {
    expect(workerCommandSchema.parse(turn)).not.toHaveProperty(
      "computerUseAuthority",
    );
  });
  it("carries standalone scratch identity and inherited permission without native turn claims", () => {
    const standalone = {
      ...authority,
      contextKind: "standalone",
      projectId: null,
      placementId: "scratch",
      profile: {
        selectedId: ":workspace",
        effectiveId: ":workspace",
        usesDefault: true,
        forcedByWorktreePolicy: false,
      },
    };
    expect(
      workerCommandSchema.parse({
        ...turn,
        contextKind: "standalone",
        executionProfile: "standalone-chat",
        worktreeId: null,
        scratchRootId: "scratch",
        rootKind: null,
        worktreeMode: null,
        worktreePolicy: null,
        policyProjectId: null,
        computerUseAuthority: standalone,
      }),
    ).toMatchObject({ computerUseAuthority: standalone });
  });
  it.each([undefined, null, "", "bad\nidentity", "x".repeat(257)])(
    "rejects missing or invalid lane identity %#",
    (executionLaneId) => {
      expect(
        workerCommandSchema.safeParse({
          ...turn,
          computerUseAuthority: { ...authority, executionLaneId },
        }).success,
      ).toBe(false);
    },
  );
  it.each([undefined, 0, -1, 1.5, 2_147_483_648, NaN, Infinity])(
    "rejects missing or invalid generation %#",
    (generation) => {
      expect(
        workerCommandSchema.safeParse({
          ...turn,
          computerUseAuthority: { ...authority, generation },
        }).success,
      ).toBe(false);
    },
  );
  it.each(["threadId", "turnId", "taskId", "script", "pixels"])(
    "rejects untrusted %s claims inside authority",
    (field) => {
      expect(
        cuaAgentAuthoritySchema.safeParse({
          ...authority,
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    },
  );
});
