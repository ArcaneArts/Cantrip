// Current Source projection is the oracle; no generated native schema is read.
import { resolveComputerUseAgentAuthority } from "../../tests/reference-node-server/src/app/routes/computer-use-agent.ts";

const now = Date.parse("2026-11-08T09:00:00.000Z");
const cases = [];
function add(name, input) {
  cases.push({
    name,
    input,
    expected: resolveComputerUseAgentAuthority(input),
  });
}
for (const contextKind of ["project", "standalone"])
  for (const permissionProfileId of [null, ":workspace", ":read-only", ":yolo"])
    for (const isPrimary of [false, true])
      for (const computerUseCantripAppAllowed of [false, true]) {
        const context = {
          contextKind,
          chatId: "chat",
          projectId: contextKind === "project" ? "project" : null,
          worktreeId: contextKind === "project" ? "worktree" : null,
          scratchRootId: contextKind === "standalone" ? "scratch" : null,
          rootKind: contextKind === "project" ? "git-worktree" : null,
          workerId: "worker",
          executionLaneId: "lane",
          computerUseEnabled: true,
          computerUseAuthorityGeneration: 7,
          computerUseCantripAppAllowed,
          permissionProfileId,
          defaultPermissionProfileId: ":workspace",
          isPrimary,
          worktreePolicy: "required-for-writes",
          threadId: "current-thread",
          status: "running",
        };
        const binding = {
          ...Object.fromEntries(
            [
              "contextKind",
              "chatId",
              "projectId",
              "worktreeId",
              "scratchRootId",
              "rootKind",
              "workerId",
              "executionLaneId",
            ].map((key) => [key, context[key]]),
          ),
          ownerId: "owner",
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 3600000).toISOString(),
          threadId: "older-thread",
          turnId: "older-turn",
        };
        const base = {
          ownerId: "owner",
          serverId: "server",
          now,
          context,
          binding,
        };
        add("current placement and policy", base);
        for (const key of [
          "ownerId",
          "contextKind",
          "chatId",
          "projectId",
          "worktreeId",
          "scratchRootId",
          "rootKind",
          "workerId",
          "executionLaneId",
        ])
          for (const value of [null, "other", undefined]) {
            const input = structuredClone(base);
            if (value === undefined) delete input.binding[key];
            else input.binding[key] = value;
            add("changed binding " + key, input);
          }
        for (const key of [
          "contextKind",
          "chatId",
          "projectId",
          "worktreeId",
          "scratchRootId",
          "rootKind",
          "workerId",
          "executionLaneId",
        ]) {
          const input = structuredClone(base);
          delete input.context[key];
          add("missing current placement " + key, input);
        }
        for (const delta of [-1, 0, 1, 60000, 60001]) {
          const input = structuredClone(base);
          input.binding.issuedAt = new Date(now + delta).toISOString();
          add("issued clock boundary " + delta, input);
          const expiry = structuredClone(base);
          expiry.binding.expiresAt = new Date(now + delta).toISOString();
          add("expiry clock boundary " + delta, expiry);
        }
        for (const computerUseEnabled of [false, null, 1])
          add("disabled current policy", {
            ...base,
            context: { ...context, computerUseEnabled },
          });
        add("current native permission projection", {
          ...base,
          context: {
            ...context,
            nativePermissionPolicy: {
              selectedId: null,
              resolvedSelectedId: ":yolo",
              effectiveId: ":read-only",
            },
          },
        });
      }
console.log(JSON.stringify(cases));
