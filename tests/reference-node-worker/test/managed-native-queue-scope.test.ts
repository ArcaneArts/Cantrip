import { describe, expect, it } from "vitest";
import { ManagedNativeQueueScope } from "../src/codex/managed-native-queue-scope.js";
const identity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  runtimeGeneration: "transport",
  modelRouteId: "route",
  providerAccountId: "account",
};
describe("managed queue scope refresh", () => {
  it.each(["modelRouteId", "providerAccountId"] as const)(
    "expires existing view capabilities on an actual %s change while retaining native execution identity",
    (field) => {
      const scope = new ManagedNativeQueueScope(identity);
      const first = scope.capture();
      const activeExecutionSession = { ...scope.identity };
      expect(scope.refresh({ ...identity })).toBe(false);
      expect(first()).toBe(true);
      expect(scope.refresh({ ...identity, [field]: "replacement" })).toBe(true);
      expect(first()).toBe(false);
      expect(scope.capture()()).toBe(true);
      expect(scope.identity[field]).toBe("replacement");
      expect(activeExecutionSession).toEqual(identity);
      expect(scope.identity.threadId).toBe(activeExecutionSession.threadId);
      expect(scope.identity.runtimeGeneration).toBe(
        activeExecutionSession.runtimeGeneration,
      );
    },
  );
  it("cannot silently transfer queue ownership across threads or owners", () => {
    const scope = new ManagedNativeQueueScope(identity);
    expect(() => scope.refresh({ ...identity, threadId: "foreign" })).toThrow(
      "owning native session",
    );
    expect(() => scope.refresh({ ...identity, ownerId: "foreign" })).toThrow(
      "owning native session",
    );
    expect(scope.identity).toEqual(identity);
  });
});
