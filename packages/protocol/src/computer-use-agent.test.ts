import { describe, expect, it } from "vitest";
import { workerCommandSchema } from "./index.js";
import { cuaAgentAuthoritySchema } from "./computer-use-agent.js";
import { cantripOsDesktopPlacement } from "./worker-command-cantrip-os.js";

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
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const osExecution = {
    kind: "cantrip-os" as const,
    transport: { kind: "docker" as const, container: "cua-fixture" },
    scope: {
      ownerId: authority.ownerId,
      workerId: authority.workerId,
      instanceId: uuid(1),
      guestInstanceId: uuid(2),
      attachmentGeneration: uuid(3),
      runtimeGeneration: uuid(4),
      bindingId: uuid(5),
      bindingGeneration: uuid(6),
      projectId: authority.projectId,
      projectSourceId: uuid(7),
      worktreeId: uuid(8),
      workspaceId: uuid(9),
      guestWorkspaceId: "work",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/work",
      guestPath: turn.cwd,
      sourceKind: "git" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
    },
  };
  const osAuthority = {
    ...authority,
    placementId: osExecution.scope.worktreeId,
    osPlacement: cantripOsDesktopPlacement(osExecution),
  };
  const osTurn = {
    ...turn,
    executionProfile: "cantrip-os",
    osExecution,
    worktreeId: osExecution.scope.worktreeId,
    computerUseAuthority: osAuthority,
  };
  it("preserves canonical Linux CUA authority through actual worker-command decoding", () => {
    expect(
      workerCommandSchema.parse(JSON.parse(JSON.stringify(osTurn))),
    ).toMatchObject({
      executionProfile: "cantrip-os",
      computerUseAuthority: osAuthority,
    });
    expect(
      workerCommandSchema.safeParse({
        ...osTurn,
        computerUseAuthority: undefined,
      }).success,
    ).toBe(true);
  });
  it.each(Object.keys(osAuthority.osPlacement))(
    "rejects a different Linux desktop %s",
    (key) => {
      expect(
        workerCommandSchema.safeParse({
          ...osTurn,
          computerUseAuthority: {
            ...osAuthority,
            osPlacement: { ...osAuthority.osPlacement, [key]: uuid(99) },
          },
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "ownerId",
    "workerId",
    "chatId",
    "projectId",
    "placementId",
    "executionLaneId",
  ])("rejects Linux CUA authority with a conflicting %s", (key) => {
    expect(
      workerCommandSchema.safeParse({
        ...osTurn,
        computerUseAuthority: { ...osAuthority, [key]: "wrong" },
      }).success,
    ).toBe(false);
  });
  it("rejects Host authority without the captured Linux destination", () => {
    expect(
      workerCommandSchema.safeParse({
        ...osTurn,
        computerUseAuthority: { ...osAuthority, osPlacement: undefined },
      }).success,
    ).toBe(false);
  });
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
