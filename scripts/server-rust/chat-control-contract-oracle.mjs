// Expectations execute the actual current protocol definitions.
import { vectorCases } from "./security-oracle.mjs";
const lane = {
  id: "lane",
  chatId: "chat",
  worktreeId: "tree",
  workerId: "worker",
  acquiringActor: "user",
  exclusive: true,
  purpose: null,
  state: "suspended",
  baseRevision: null,
  startingHead: null,
  runtimeSessionId: null,
  codexThreadId: null,
  transitionKind: null,
  createdAt: "2026-10-25T00:00:00.123Z",
  activatedAt: null,
  releasedAt: null,
  updatedAt: "2026-10-25T00:00:00.123Z",
};
const samples = {
  chatWorktreeUpdateSchema: [
    { worktreeId: "tree", mode: "pinned" },
    { worktreeId: "tree", mode: "agent-managed" },
  ],
  chatExecutionLaneReleaseSchema: [
    {},
    { allowDirty: true, returnToPrimary: false },
  ],
  chatExecutionLaneListSchema: [
    [],
    [lane],
    [{ ...lane, contextKind: "project", scratchRootId: null }],
  ],
  chatCompactAcceptedSchema: [{ accepted: true }],
};
const name = process.argv[2];
console.log(JSON.stringify({ cases: [...vectorCases(name, samples[name])] }));
